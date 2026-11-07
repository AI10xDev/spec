//! Shared-workspace entitlements. Provider credentials and pinned bodies never enter catalog views.
use crate::{App, Error, Result, settings};
use axum::{
    Json,
    extract::{Path, State, rejection::JsonRejection},
    http::StatusCode,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use reqwest::{Client, RequestBuilder, Url};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;
use uuid::Uuid;

const MAX_CONTENT: usize = 32 * 1024;
const MAX_LEDGER: usize = 8 * 1024 * 1024;
const KEYS: [&str; 8] = [
    "SPEC_SKILLS_GITHUB_TOKEN",
    "SPEC_SKILLS_GITHUB_REPO",
    "SPEC_SKILLS_GITHUB_REF",
    "SPEC_PAYPAL_CLIENT_ID",
    "SPEC_PAYPAL_CLIENT_SECRET",
    "SPEC_PAYPAL_MERCHANT_ID",
    "SPEC_PAYPAL_RETURN_URL",
    "SPEC_PAYPAL_MODE",
];

// Intentionally no Debug implementations for credentials, provider responses, or receipts.
struct Config {
    token: String,
    repository: String,
    reference: String,
    client_id: String,
    secret: String,
    merchant: String,
    return_url: String,
    mode: String,
}

impl Config {
    fn parse(values: &HashMap<String, String>) -> std::result::Result<Option<Self>, &'static str> {
        if !KEYS.iter().any(|key| values.contains_key(*key)) {
            return Ok(None);
        }
        let required =
            |key: &str| {
                values.get(key).filter(|s| !s.trim().is_empty()).cloned()
            .ok_or("Incomplete marketplace configuration; configure GitHub and PayPal together")
            };
        let config = Self {
            token: required(KEYS[0])?,
            repository: required(KEYS[1])?,
            reference: values
                .get(KEYS[2])
                .cloned()
                .unwrap_or_else(|| "main".into()),
            client_id: required(KEYS[3])?,
            secret: required(KEYS[4])?,
            merchant: required(KEYS[5])?,
            return_url: required(KEYS[6])?,
            mode: values
                .get(KEYS[7])
                .cloned()
                .unwrap_or_else(|| "sandbox".into()),
        };
        let repo: Vec<_> = config.repository.split('/').collect();
        let url = Url::parse(&config.return_url).map_err(|_| "Invalid marketplace return URL")?;
        if repo.len() != 2
            || !repo.iter().all(|s| identifier(s))
            || config.reference.is_empty()
            || config.reference.len() > 200
            || config.reference.chars().any(char::is_control)
            || !identifier(&config.merchant)
            || !matches!(config.mode.as_str(), "sandbox" | "live")
            || url.scheme() != "https"
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || url.query().is_some()
        {
            return Err(
                "Invalid marketplace configuration; use sandbox or live and an HTTPS return URL without credentials, query or fragment",
            );
        }
        Ok(Some(config))
    }

    fn paypal_origin(&self) -> &'static str {
        if self.mode == "live" {
            "https://api-m.paypal.com"
        } else {
            "https://api-m.sandbox.paypal.com"
        }
    }
}

pub struct Store {
    config: Option<Config>,
    unavailable: Option<&'static str>,
    file: settings::PrivateFile,
    namespace: String,
    client: Client,
    gate: Mutex<()>,
    #[cfg(test)]
    origins: Option<(String, String)>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Skill {
    id: String,
    name: String,
    path: String,
    description: String,
    price: String,
    currency: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    skills: Vec<Skill>,
}

struct Catalog {
    revision: String,
    skills: Vec<(Skill, String)>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrderLink {
    id: String,
    approval_url: String,
}

#[derive(Serialize)]
struct SkillView {
    #[serde(flatten)]
    skill: Skill,
    purchased: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    order: Option<OrderLink>,
}

#[derive(Serialize)]
pub struct CatalogView {
    mode: String,
    repository: String,
    skills: Vec<SkillView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    warning: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Receipt {
    skill: Skill,
    revision: String,
    content: String,
    request_id: String,
    created: u64,
    order: Option<OrderLink>,
    purchased: bool,
    // Persisted receipts from before replacement support are still active.
    #[serde(default)]
    retired: bool,
}

#[derive(Serialize, Deserialize)]
struct Ledger {
    namespace: String,
    receipts: Vec<Receipt>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OrderInput {
    skill_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CaptureInput {}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderView {
    id: String,
    approval_url: Option<String>,
    purchased: bool,
}

fn failure(message: &'static str) -> Error {
    Error(StatusCode::BAD_GATEWAY, message.into())
}
fn storage_error() -> Error {
    Error(
        StatusCode::SERVICE_UNAVAILABLE,
        "Marketplace receipt storage unavailable; retry the same purchase or payment check".into(),
    )
}
fn invalid() -> Error {
    failure("Invalid marketplace catalog or provider response")
}
fn identifier(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 100
        && s != "."
        && s != ".."
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
}
fn cents(s: &str) -> Option<u64> {
    let (whole, fraction) = s.split_once('.')?;
    if whole.is_empty()
        || whole.len() > 6
        || fraction.len() != 2
        || !whole
            .bytes()
            .chain(fraction.bytes())
            .all(|b| b.is_ascii_digit())
        || (whole.len() > 1 && whole.starts_with('0'))
    {
        return None;
    }
    let value = whole.parse::<u64>().ok()? * 100 + fraction.parse::<u64>().ok()?;
    (value > 0).then_some(value)
}
fn valid_skill(skill: &Skill) -> bool {
    identifier(&skill.id)
        && !skill.name.trim().is_empty()
        && skill.name.len() <= 120
        && !skill.description.trim().is_empty()
        && skill.description.len() <= 2000
        && !skill.name.chars().any(char::is_control)
        && skill.path.len() <= 500
        && skill.path.split('/').all(identifier)
        && skill.path.rsplit('/').next().is_some_and(|s| {
            s.eq_ignore_ascii_case("skills.md") || s.eq_ignore_ascii_case("skill.md")
        })
        && matches!(
            skill.currency.as_str(),
            "USD" | "EUR" | "GBP" | "CAD" | "AUD"
        )
        && cents(&skill.price).is_some()
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

impl Store {
    pub fn from_env(settings: &settings::Store) -> std::result::Result<Self, &'static str> {
        let mut values = match crate::ai_settings::from_env() {
            Ok(values) => values,
            Err(_) => {
                // A saved AI profile may legitimately override a broken text dotenv.
                // Keep that server usable, but do not assume marketplace config is absent.
                let mut store = Self::open(None, settings)
                    .map_err(|_| "Could not open private marketplace receipt storage")?;
                store.unavailable = Some(
                    "Marketplace unavailable: shared dotenv configuration could not be read; repair it and restart",
                );
                return Ok(store);
            }
        };
        for key in KEYS {
            if let Some(value) = std::env::var_os(key) {
                values.insert(
                    key.into(),
                    value
                        .into_string()
                        .map_err(|_| "Invalid marketplace environment value")?,
                );
            }
        }
        Self::open(Config::parse(&values)?, settings)
            .map_err(|_| "Could not open private marketplace receipt storage")
    }

    fn open(config: Option<Config>, settings: &settings::Store) -> Result<Self> {
        let namespace = config.as_ref().map_or_else(
            || "demo-v1".into(),
            |c| {
                format!(
                    "{}-{:x}",
                    c.mode,
                    Sha256::digest(
                        serde_json::to_vec(&json!([
                            c.mode,
                            c.repository,
                            c.reference,
                            c.client_id,
                            c.merchant
                        ]))
                        .unwrap()
                    )
                )
            },
        );
        let store = Self {
            file: settings.marketplace_file(&namespace),
            namespace,
            config,
            unavailable: None,
            client: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(20))
                .connect_timeout(Duration::from_secs(5))
                .build()
                .map_err(|_| invalid())?,
            gate: Mutex::new(()),
            #[cfg(test)]
            origins: None,
        };
        store.load()?;
        Ok(store)
    }

    #[cfg(test)]
    pub fn demo(settings: &settings::Store) -> Self {
        Self::open(None, settings).ok().unwrap()
    }

    fn load(&self) -> Result<Ledger> {
        if let Some(message) = self.unavailable {
            return Err(Error(StatusCode::SERVICE_UNAVAILABLE, message.into()));
        }
        let ledger: Ledger = match self
            .file
            .load_bounded(MAX_LEDGER)
            .map_err(|_| storage_error())?
        {
            Some(bytes) => serde_json::from_slice(&bytes).map_err(|_| storage_error())?,
            None => Ledger {
                namespace: self.namespace.clone(),
                receipts: vec![],
            },
        };
        let mut active = HashSet::new();
        if ledger.namespace != self.namespace
            || ledger.receipts.len() > 100
            || ledger.receipts.iter().any(|r| {
                !valid_skill(&r.skill)
                    || (r.retired && (r.purchased || r.order.is_none()))
                    || (!r.retired && !active.insert(r.skill.id.clone()))
                    || r.content.len() > MAX_CONTENT
                    || (self.config.is_some()
                        && (r.revision == "demo-v1" || r.request_id.starts_with("demo")))
            })
        {
            return Err(storage_error());
        }
        Ok(ledger)
    }

    // A previous rename may be visible even though its directory sync failed.
    // Every API entry holds the gate and re-establishes durability before using it.
    fn confirmed_ledger(&self) -> Result<Ledger> {
        let ledger = self.load()?;
        if !ledger.receipts.is_empty() {
            self.save(&ledger)?;
        }
        Ok(ledger)
    }

    fn save(&self, ledger: &Ledger) -> Result<()> {
        self.file
            .persist_bounded(
                &serde_json::to_vec(ledger).map_err(|_| storage_error())?,
                MAX_LEDGER,
                true,
            )
            .map_err(|_| storage_error())
    }

    fn origin(&self, github: bool) -> &str {
        #[cfg(test)]
        if let Some((git, paypal)) = &self.origins {
            return if github { git } else { paypal };
        }
        if github {
            "https://api.github.com"
        } else {
            self.config.as_ref().unwrap().paypal_origin()
        }
    }

    async fn response(&self, request: RequestBuilder, limit: usize) -> Result<Value> {
        let mut response = request
            .send()
            .await
            .map_err(|_| failure("Marketplace provider unavailable; retry the same request"))?;
        if !response.status().is_success() {
            return Err(failure(
                "Marketplace provider rejected the request; approval may still be required. Retry Check payment after approval",
            ));
        }
        if response
            .content_length()
            .is_some_and(|len| len > limit as u64)
        {
            return Err(invalid());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| {
            failure("Marketplace provider response interrupted; retry the same request")
        })? {
            if bytes.len() + chunk.len() > limit {
                return Err(invalid());
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| invalid())
    }

    async fn github(&self, segments: &[&str], query: &[(&str, &str)]) -> Result<Value> {
        let c = self.config.as_ref().unwrap();
        let mut url = Url::parse(self.origin(true)).map_err(|_| invalid())?;
        url.path_segments_mut()
            .map_err(|_| invalid())?
            .extend(["repos"])
            .extend(c.repository.split('/'))
            .extend(segments);
        self.response(
            self.client
                .get(url)
                .query(query)
                .bearer_auth(&c.token)
                .header("User-Agent", "Spec-Skills-Marketplace")
                .header("Accept", "application/vnd.github+json")
                .header("X-GitHub-Api-Version", "2022-11-28"),
            2 * 1024 * 1024,
        )
        .await
    }

    async fn blob(&self, sha: &str, limit: usize) -> Result<String> {
        if sha.len() != 40 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(invalid());
        }
        let blob = self.github(&["git", "blobs", sha], &[]).await?;
        if blob["encoding"] != "base64" || blob["size"].as_u64().is_none_or(|s| s > limit as u64) {
            return Err(invalid());
        }
        let encoded = blob["content"]
            .as_str()
            .ok_or_else(invalid)?
            .replace(['\n', '\r'], "");
        let bytes = STANDARD.decode(encoded).map_err(|_| invalid())?;
        if bytes.len() > limit || bytes.contains(&0) {
            return Err(invalid());
        }
        String::from_utf8(bytes).map_err(|_| invalid())
    }

    async fn catalog(&self) -> Result<Catalog> {
        let Some(c) = &self.config else {
            return Ok(Catalog {
                revision: "demo-v1".into(),
                skills: demo_skills()
                    .into_iter()
                    .map(|(s, _)| (s, String::new()))
                    .collect(),
            });
        };
        let commit = self.github(&["commits", &c.reference], &[]).await?;
        let revision = commit["sha"]
            .as_str()
            .filter(|s| s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or_else(invalid)?
            .to_owned();
        let tree = self
            .github(&["git", "trees", &revision], &[("recursive", "1")])
            .await?;
        if tree["truncated"] != false {
            return Err(failure(
                "Marketplace repository tree is too large or incomplete",
            ));
        }
        let tree = tree["tree"]
            .as_array()
            .filter(|t| t.len() <= 10000)
            .ok_or_else(invalid)?;
        let files: HashMap<_, _> = tree
            .iter()
            .filter(|v| v["type"] == "blob" && (v["mode"] == "100644" || v["mode"] == "100755"))
            .filter_map(|v| Some((v["path"].as_str()?, v["sha"].as_str()?)))
            .collect();
        let manifest = self
            .blob(
                files.get("skills-index.json").ok_or_else(invalid)?,
                128 * 1024,
            )
            .await?;
        let manifest: Manifest = serde_json::from_str(&manifest).map_err(|_| invalid())?;
        if manifest.skills.is_empty() || manifest.skills.len() > 100 {
            return Err(invalid());
        }
        let mut ids = HashSet::new();
        let mut paths = HashSet::new();
        let mut skills = vec![];
        for skill in manifest.skills {
            if !valid_skill(&skill)
                || !ids.insert(skill.id.clone())
                || !paths.insert(skill.path.clone())
            {
                return Err(invalid());
            }
            let sha = files
                .get(skill.path.as_str())
                .ok_or_else(invalid)?
                .to_string();
            skills.push((skill, sha));
        }
        Ok(Catalog { revision, skills })
    }

    async fn access_token(&self) -> Result<String> {
        let c = self.config.as_ref().unwrap();
        let token = self
            .response(
                self.client
                    .post(format!("{}/v1/oauth2/token", self.origin(false)))
                    .basic_auth(&c.client_id, Some(&c.secret))
                    .form(&[("grant_type", "client_credentials")]),
                16 * 1024,
            )
            .await?;
        token["access_token"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() < 8192)
            .map(str::to_owned)
            .ok_or_else(invalid)
    }

    fn approval(&self, value: &Value, id: &str) -> Result<String> {
        let href = value["links"]
            .as_array()
            .and_then(|links| links.iter().find(|v| v["rel"] == "approve"))
            .and_then(|v| v["href"].as_str())
            .ok_or_else(invalid)?;
        let url = Url::parse(href).map_err(|_| invalid())?;
        let host = if self.config.as_ref().unwrap().mode == "live" {
            "www.paypal.com"
        } else {
            "www.sandbox.paypal.com"
        };
        if url.scheme() != "https"
            || url.host_str() != Some(host)
            || url.port().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || url.path() != "/checkoutnow"
            || url.query_pairs().filter(|(k, _)| k == "token").count() != 1
            || !url.query_pairs().any(|(k, v)| k == "token" && v == id)
        {
            return Err(invalid());
        }
        Ok(href.into())
    }

    async fn create_provider_order(&self, receipt: &Receipt) -> Result<OrderLink> {
        // PayPal's default request-id retention is six hours. Never replay an ambiguous
        // create beyond that window: it could charge twice instead of recovering.
        if now().saturating_sub(receipt.created) > 5 * 3600 {
            return Err(Error(StatusCode::CONFLICT, "Unresolved PayPal order requires merchant reconciliation; no new order was created".into()));
        }
        let c = self.config.as_ref().unwrap();
        let token = self.access_token().await?;
        let value = self.response(self.client.post(format!("{}/v2/checkout/orders", self.origin(false)))
            .bearer_auth(token).header("PayPal-Request-Id", &receipt.request_id).header("Prefer", "return=representation")
            .json(&json!({"intent":"CAPTURE", "purchase_units":[{
                "reference_id":receipt.skill.id, "custom_id":receipt.request_id,
                "amount":{"currency_code":receipt.skill.currency,"value":receipt.skill.price},
                "payee":{"merchant_id":c.merchant}
            }], "application_context":{"return_url":c.return_url,"cancel_url":c.return_url,"user_action":"PAY_NOW","shipping_preference":"NO_SHIPPING"}})), 128 * 1024).await?;
        let id = value["id"]
            .as_str()
            .filter(|s| identifier(s))
            .ok_or_else(invalid)?
            .to_owned();
        let approval_url = self.approval(&value, &id)?;
        Ok(OrderLink { id, approval_url })
    }

    fn bound_order(&self, value: &Value, receipt: &Receipt) -> bool {
        let Some(order) = &receipt.order else {
            return false;
        };
        let Some(units) = value["purchase_units"].as_array().filter(|u| u.len() == 1) else {
            return false;
        };
        let unit = &units[0];
        value["id"] == order.id
            && value["intent"] == "CAPTURE"
            && unit["custom_id"] == receipt.request_id
            && unit["reference_id"] == receipt.skill.id
            && unit["payee"]["merchant_id"] == self.config.as_ref().unwrap().merchant
            && unit["amount"]["currency_code"] == receipt.skill.currency
            && unit["amount"]["value"].as_str().and_then(cents) == cents(&receipt.skill.price)
    }

    fn verified(&self, value: &Value, receipt: &Receipt) -> bool {
        if !self.bound_order(value, receipt) {
            return false;
        }
        let unit = &value["purchase_units"][0];
        let Some(captures) = unit["payments"]["captures"]
            .as_array()
            .filter(|c| c.len() == 1)
        else {
            return false;
        };
        let capture = &captures[0];
        let amount = |v: &Value| {
            v["currency_code"] == receipt.skill.currency
                && v["value"].as_str().and_then(cents) == cents(&receipt.skill.price)
        };
        value["status"] == "COMPLETED"
            && amount(&capture["amount"])
            && capture["status"] == "COMPLETED"
            && capture["final_capture"] == true
            && capture["id"].as_str().is_some_and(identifier)
            && capture
                .pointer("/supplementary_data/related_ids/order_id")
                .is_none_or(|id| id == &receipt.order.as_ref().unwrap().id)
    }

    async fn order(&self, ledger: &mut Ledger, skill_id: &str) -> Result<OrderView> {
        let index = match ledger
            .receipts
            .iter()
            .position(|r| r.skill.id == skill_id && !r.retired)
        {
            Some(index) => index,
            None => {
                if ledger.receipts.len() >= 100 {
                    return Err(Error(
                        StatusCode::CONFLICT,
                        "Marketplace receipt history is full; merchant reconciliation required"
                            .into(),
                    ));
                }
                let (skill, revision, content) = if let Some(retired) = ledger
                    .receipts
                    .iter()
                    .rev()
                    .find(|r| r.skill.id == skill_id)
                {
                    (
                        retired.skill.clone(),
                        retired.revision.clone(),
                        retired.content.clone(),
                    )
                } else {
                    let catalog = self.catalog().await?;
                    let (skill, sha) = catalog
                        .skills
                        .into_iter()
                        .find(|(s, _)| s.id == skill_id)
                        .ok_or_else(|| {
                        Error(StatusCode::NOT_FOUND, "Skill not found".into())
                    })?;
                    let content = if self.config.is_some() {
                        self.blob(&sha, MAX_CONTENT).await?
                    } else {
                        demo_skills()
                            .into_iter()
                            .find(|(s, _)| s.id == skill.id)
                            .unwrap()
                            .1
                            .into()
                    };
                    (skill, catalog.revision, content)
                };
                ledger.receipts.push(Receipt {
                    skill,
                    revision,
                    content,
                    request_id: Uuid::new_v4().to_string(),
                    created: now(),
                    order: None,
                    purchased: self.config.is_none(),
                    retired: false,
                });
                // Persist the new binding before any external payment side effect.
                self.save(ledger)?;
                ledger.receipts.len() - 1
            }
        };
        if self.config.is_some() && ledger.receipts[index].order.is_none() {
            let order = self.create_provider_order(&ledger.receipts[index]).await?;
            ledger.receipts[index].order = Some(order);
            self.save(ledger)?;
        }
        let receipt = &ledger.receipts[index];
        Ok(OrderView {
            id: receipt
                .order
                .as_ref()
                .map_or_else(|| receipt.request_id.clone(), |o| o.id.clone()),
            approval_url: receipt.order.as_ref().map(|o| o.approval_url.clone()),
            purchased: receipt.purchased,
        })
    }
}

pub async fn catalog(State(app): State<App>) -> Result<Json<CatalogView>> {
    let store = &app.marketplace;
    let _guard = store.gate.lock().await;
    let ledger = store.confirmed_ledger()?;
    let (listings, warning) = match store.catalog().await {
        Ok(catalog) => (catalog.skills, None),
        Err(_) if !ledger.receipts.is_empty() => (vec![], Some("GitHub catalog unavailable. Showing stored purchases and orders only; new listings may be missing.".into())),
        Err(error) => return Err(error),
    };
    let mut skills: Vec<_> = listings
        .into_iter()
        .map(|(skill, _)| {
            let receipt = ledger
                .receipts
                .iter()
                .rev()
                .find(|r| r.skill.id == skill.id);
            SkillView {
                skill: receipt.map_or(skill, |r| r.skill.clone()),
                purchased: receipt.is_some_and(|r| r.purchased),
                order: receipt
                    .filter(|r| !r.purchased && !r.retired)
                    .and_then(|r| r.order.clone()),
            }
        })
        .collect();
    // Removed listings must not hide purchased files or a recoverable payment.
    for receipt in ledger.receipts.iter().rev() {
        if !skills.iter().any(|s| s.skill.id == receipt.skill.id) {
            skills.push(SkillView {
                skill: receipt.skill.clone(),
                purchased: receipt.purchased,
                order: (!receipt.purchased && !receipt.retired)
                    .then(|| receipt.order.clone())
                    .flatten(),
            });
        }
    }
    Ok(Json(CatalogView {
        mode: store
            .config
            .as_ref()
            .map_or("demo", |c| c.mode.as_str())
            .into(),
        repository: store
            .config
            .as_ref()
            .map_or("Spec example skills (simulation)", |c| {
                c.repository.as_str()
            })
            .into(),
        skills,
        warning,
    }))
}

pub async fn order(
    State(app): State<App>,
    input: std::result::Result<Json<OrderInput>, JsonRejection>,
) -> Result<Json<OrderView>> {
    let Json(input) = input.map_err(|_| {
        Error(
            StatusCode::BAD_REQUEST,
            "Invalid marketplace order request".into(),
        )
    })?;
    if !identifier(&input.skill_id) {
        return Err(Error(StatusCode::BAD_REQUEST, "Invalid skill ID".into()));
    }
    let store = &app.marketplace;
    let _guard = store.gate.lock().await;
    let mut ledger = store.confirmed_ledger()?;
    store.order(&mut ledger, &input.skill_id).await.map(Json)
}

pub async fn replace(
    State(app): State<App>,
    Path(id): Path<String>,
    input: std::result::Result<Json<CaptureInput>, JsonRejection>,
) -> Result<Json<OrderView>> {
    let Json(_) = input.map_err(|_| {
        Error(
            StatusCode::BAD_REQUEST,
            "Invalid marketplace replacement request".into(),
        )
    })?;
    let store = &app.marketplace;
    let _guard = store.gate.lock().await;
    let mut ledger = store.confirmed_ledger()?;
    let index = ledger
        .receipts
        .iter()
        .position(|r| r.order.as_ref().is_some_and(|o| o.id == id))
        .ok_or_else(|| Error(StatusCode::NOT_FOUND, "Order not found".into()))?;
    let receipt = &ledger.receipts[index];
    let skill_id = receipt.skill.id.clone();
    if !receipt.retired {
        if receipt.purchased || store.config.is_none() || ledger.receipts.len() >= 100 {
            return Err(Error(
                StatusCode::CONFLICT,
                "Order cannot be replaced; purchased or receipt history is full".into(),
            ));
        }
        let token = store.access_token().await?;
        let value = store
            .response(
                store
                    .client
                    .get(format!("{}/v2/checkout/orders/{id}", store.origin(false)))
                    .bearer_auth(token),
                128 * 1024,
            )
            .await?;
        let no_payments = match value.pointer("/purchase_units/0/payments") {
            None => true,
            Some(Value::Object(payments)) => payments.iter().all(|(kind, entries)| {
                matches!(kind.as_str(), "captures" | "authorizations" | "refunds")
                    && entries.as_array().is_some_and(Vec::is_empty)
            }),
            _ => false,
        };
        if !store.bound_order(&value, receipt) || value["status"] != "VOIDED" || !no_payments {
            return Err(Error(StatusCode::CONFLICT, "Replacement requires a verified matching VOIDED order with no payments; otherwise check payment or contact the merchant".into()));
        }
        ledger.receipts[index].retired = true;
        // Retirement must be durable before even creating a replacement intent.
        store.save(&ledger)?;
    }
    // Repeated requests for any retired order reuse the skill's active replacement.
    store.order(&mut ledger, &skill_id).await.map(Json)
}

pub async fn capture(
    State(app): State<App>,
    Path(id): Path<String>,
    input: std::result::Result<Json<CaptureInput>, JsonRejection>,
) -> Result<Json<Value>> {
    let Json(_) = input.map_err(|_| {
        Error(
            StatusCode::BAD_REQUEST,
            "Invalid marketplace capture request".into(),
        )
    })?;
    let store = &app.marketplace;
    let _guard = store.gate.lock().await;
    let mut ledger = store.confirmed_ledger()?;
    let index = ledger
        .receipts
        .iter()
        .position(|r| {
            r.order.as_ref().is_some_and(|o| o.id == id)
                || (store.config.is_none() && r.request_id == id)
        })
        .ok_or_else(|| Error(StatusCode::NOT_FOUND, "Order not found".into()))?;
    let receipt = &ledger.receipts[index];
    if receipt.retired {
        return Err(Error(
            StatusCode::CONFLICT,
            "Order was retired; use its replacement order".into(),
        ));
    }
    if receipt.purchased {
        return Ok(Json(json!({"purchased":true})));
    }
    let token = store.access_token().await?;
    let url = format!("{}/v2/checkout/orders/{id}", store.origin(false));
    let mut value = store
        .response(store.client.get(&url).bearer_auth(&token), 128 * 1024)
        .await?;
    if !store.bound_order(&value, receipt) {
        return Err(invalid());
    }
    if value["status"] == "APPROVED" {
        // Stable across timeouts and restarts. GET above recovers a capture whose response was lost.
        store
            .response(
                store
                    .client
                    .post(format!("{url}/capture"))
                    .bearer_auth(&token)
                    .header("PayPal-Request-Id", format!("c-{}", receipt.request_id))
                    .json(&json!({})),
                128 * 1024,
            )
            .await?;
        value = store
            .response(store.client.get(&url).bearer_auth(&token), 128 * 1024)
            .await?;
    }
    if !store.verified(&value, receipt) {
        return Err(Error(StatusCode::CONFLICT, "Payment is not a verified completed purchase; approve in PayPal, then retry Check payment".into()));
    }
    ledger.receipts[index].purchased = true;
    store.save(&ledger)?;
    Ok(Json(json!({"purchased":true})))
}

pub async fn content(State(app): State<App>, Path(id): Path<String>) -> Result<Json<Value>> {
    let store = &app.marketplace;
    let _guard = store.gate.lock().await;
    let ledger = store.confirmed_ledger()?;
    let receipt = ledger
        .receipts
        .iter()
        .find(|r| r.skill.id == id && r.purchased && !r.retired)
        .ok_or_else(|| {
            Error(
                StatusCode::FORBIDDEN,
                "Purchase this skill before viewing its content".into(),
            )
        })?;
    Ok(Json(json!({"content":receipt.content})))
}

fn demo_skills() -> Vec<(Skill, &'static str)> {
    [
        ("code-review", "Code Review", "Review changes for correctness, security, and missing tests.", "# Code Review\n\n## Workflow\n1. Read the diff and surrounding code.\n2. Trace changed inputs through validation and persistence.\n3. Check error paths and authorization boundaries.\n4. Run focused regression tests.\n5. Report actionable findings with file and line references, highest severity first.\n\nDo not invent issues. State testing gaps explicitly.\n"),
        ("test-design", "Test Design", "Turn acceptance criteria into focused regression tests.", "# Test Design\n\n## Workflow\n1. List observable acceptance criteria.\n2. Cover the happy path, invalid input, and dependency failure.\n3. Use isolated fixtures and deterministic clocks.\n4. Assert externally visible behavior rather than implementation details.\n5. Run the smallest relevant suite, then adjacent tests.\n\nNever use production credentials or make real purchases in tests.\n"),
        ("release-check", "Release Check", "Prepare a concise, evidence-based release checklist.", "# Release Check\n\n## Workflow\n1. Review all commits since the previous release.\n2. Identify migrations, configuration changes, and compatibility risks.\n3. Run tests, formatting, and static analysis.\n4. Document rollback steps and known limitations.\n5. Ask for explicit approval before publishing or deploying.\n\nSeparate verified results from assumptions.\n"),
    ].into_iter().map(|(id, name, description, content)| (Skill { id: id.into(), name: name.into(), path: format!("{id}/skills.md"), description: description.into(), price: "5.00".into(), currency: "USD".into() }, content)).collect()
}

#[cfg(test)]
#[path = "marketplace_tests.rs"]
mod tests;

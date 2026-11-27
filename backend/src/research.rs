//! Exa-native, read-only research. No jobs, file writes, tools, or automatic retries.
use crate::{App, Error, Result, invalid};
use axum::{Json, extract::State, http::StatusCode};
use reqwest::{Client, Url, header::HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tokio::sync::Semaphore;

pub(super) const MAX_BODY: usize = 64 * 1024;
const MAX_QUERY: usize = 8 * 1024;
const MAX_RESPONSE: usize = 1024 * 1024;
const MAX_REPORT: usize = 64 * 1024;
const TIMEOUT: Duration = Duration::from_secs(90);
const SETUP: &str = "Deep research is unavailable. Set a valid EXA_API_KEY in the server environment or shared .env (SPEC_AI_ENV_FILE), then restart. Never enter keys in the research question.";

#[derive(Clone)]
pub(super) struct Research {
    client: Client,
    key: HeaderValue,
    url: Url,
    slots: Arc<Semaphore>,
    timeout: Duration,
}

impl Research {
    pub(super) fn from_env() -> std::result::Result<Option<Self>, &'static str> {
        let settings = crate::ai_settings::from_env()?;
        let key = match std::env::var("EXA_API_KEY") {
            Ok(value) => Some(value),
            Err(std::env::VarError::NotPresent) => settings.get("EXA_API_KEY").cloned(),
            Err(_) => return Err("EXA_API_KEY must be valid UTF-8"),
        };
        Self::configured(key.as_deref())
    }

    fn configured(key: Option<&str>) -> std::result::Result<Option<Self>, &'static str> {
        let Some(key) = key else { return Ok(None) };
        if key.is_empty() {
            return Ok(None);
        }
        if key.len() > 4096 || !key.bytes().all(|c| c.is_ascii_graphic()) {
            return Err("EXA_API_KEY must be bounded ASCII without whitespace or controls");
        }
        let mut key = HeaderValue::from_str(key).map_err(|_| "Invalid EXA_API_KEY")?;
        key.set_sensitive(true);
        Ok(Some(Self {
            client: Client::builder()
                .https_only(true)
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .connect_timeout(Duration::from_secs(10))
                .timeout(TIMEOUT)
                .build()
                .map_err(|_| "Could not initialize Exa HTTPS client")?,
            key,
            url: Url::parse("https://api.exa.ai/search").unwrap(),
            slots: Arc::new(Semaphore::new(1)),
            timeout: TIMEOUT,
        }))
    }

    async fn run(&self, query: &str) -> Result<Output> {
        validate_query(query)?;
        let _permit = self.slots.try_acquire().map_err(|_| Error(StatusCode::TOO_MANY_REQUESTS,
            "Another research request is active on this server. Wait before explicitly trying again.".into()))?;
        tokio::time::timeout(self.timeout, async {
            let mut response = self
                .client
                .post(self.url.clone())
                .header("x-api-key", self.key.clone())
                .json(&payload(query))
                .send()
                .await
                .map_err(transport)?;
            if !response.status().is_success() {
                let message = match response.status().as_u16() {
                    401 => "Exa authentication failed. Check the server-side key.",
                    402 => "Exa credits or spending budget exhausted.",
                    403 => "Exa access denied for this account or feature.",
                    429 => "Exa rate limit reached. Wait before explicitly trying again.",
                    _ => "Exa could not complete the request. No automatic retry was made.",
                };
                return Err(Error(StatusCode::BAD_GATEWAY, message.into()));
            }
            if response
                .content_length()
                .is_some_and(|n| n > MAX_RESPONSE as u64)
            {
                return Err(bad_response());
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(transport)? {
                if chunk.len() > MAX_RESPONSE - bytes.len() {
                    return Err(bad_response());
                }
                bytes.extend_from_slice(&chunk);
            }
            normalize(serde_json::from_slice(&bytes).map_err(|_| bad_response())?)
        })
        .await
        .map_err(|_| timed_out())?
    }
}

fn timed_out() -> Error {
    Error(StatusCode::GATEWAY_TIMEOUT, "Exa research timed out. Provider work and charges may continue; no automatic retry was made.".into())
}
fn transport(error: reqwest::Error) -> Error {
    if error.is_timeout() {
        timed_out()
    } else {
        Error(StatusCode::BAD_GATEWAY, "Could not receive Exa research. Provider work and charges may continue; no automatic retry was made.".into())
    }
}
fn bad_response() -> Error {
    Error(
        StatusCode::BAD_GATEWAY,
        "Exa returned invalid, incomplete, or oversized research. No automatic retry was made."
            .into(),
    )
}
fn validate_query(query: &str) -> Result<()> {
    if query.trim().is_empty() || query.len() > MAX_QUERY || query.contains('\0') {
        return Err(invalid(
            "Question must be nonempty, NUL-free, and at most 8 KiB of UTF-8. Nothing was sent.",
        ));
    }
    Ok(())
}
fn payload(query: &str) -> Value {
    json!({"query": query, "type": "deep", "numResults": 10,
    "outputSchema": {"type": "object", "additionalProperties": false,
        "required": ["title", "summary", "findings", "limitations"],
        "properties": {
            "title": {"type": "string"}, "summary": {"type": "string"},
            "findings": {"type": "array", "maxItems": 20, "items": {"type": "string"}},
            "limitations": {"type": "array", "maxItems": 20, "items": {"type": "string"}}
        }}})
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Input {
    query: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Report {
    title: String,
    summary: String,
    findings: Vec<String>,
    limitations: Vec<String>,
}
#[derive(Serialize)]
struct Source {
    id: usize,
    url: String,
    title: String,
}
#[derive(Serialize)]
pub(super) struct Output {
    report: Report,
    sources: Vec<Source>,
    // Exact schema field paths -> one-based source IDs. No invented citations/confidence.
    grounding: BTreeMap<String, Vec<usize>>,
    warnings: Vec<String>,
}

fn safe_url(raw: &str) -> Option<String> {
    if raw.len() > 4096
        || raw.chars().any(|c| c.is_control() || c.is_whitespace())
        || raw.contains('\\')
    {
        return None;
    }
    if !(raw.starts_with("https://") || raw.starts_with("http://")) {
        return None;
    }
    let url = Url::parse(raw).ok()?;
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || raw.split('/').nth(2)?.contains('@')
    {
        return None;
    }
    Some(url.into())
}

fn normalize(value: Value) -> Result<Output> {
    let content = value.pointer("/output/content").ok_or_else(bad_response)?;
    let report: Report = serde_json::from_value(content.clone()).map_err(|_| bad_response())?;
    if report.title.trim().is_empty()
        || report.summary.trim().is_empty()
        || report.findings.is_empty()
        || report.findings.len() > 20
        || report.limitations.len() > 20
        || std::iter::once(&report.title)
            .chain(std::iter::once(&report.summary))
            .chain(&report.findings)
            .chain(&report.limitations)
            .any(|s| s.trim().is_empty() || s.contains('\0'))
        || serde_json::to_vec(&report)
            .map_err(|_| bad_response())?
            .len()
            > MAX_REPORT
    {
        return Err(bad_response());
    }
    let fields: Vec<String> = ["title".into(), "summary".into()]
        .into_iter()
        .chain((0..report.findings.len()).map(|i| format!("findings[{i}]")))
        .chain((0..report.limitations.len()).map(|i| format!("limitations[{i}]")))
        .collect();
    let mut output = Output { report, sources: vec![], grounding: BTreeMap::new(), warnings: vec![
        "Generated research, not implementation or verified test evidence. Exa citations are provider-supplied provenance, not independent verification.".into()
    ] };
    let mut omitted = false;
    match value.pointer("/output/grounding") {
        None | Some(Value::Null) => {}
        Some(Value::Array(entries)) if entries.len() <= 128 => {
            for entry in entries {
                let Some(field) = entry
                    .get("field")
                    .and_then(Value::as_str)
                    .filter(|f| fields.iter().any(|v| v == f))
                else {
                    omitted = true;
                    continue;
                };
                let Some(citations) = entry.get("citations").and_then(Value::as_array) else {
                    omitted = true;
                    continue;
                };
                if citations.len() > 128 {
                    return Err(bad_response());
                }
                for citation in citations {
                    if let Some(id) = add_source(&mut output.sources, citation)? {
                        let ids = output.grounding.entry(field.into()).or_default();
                        if !ids.contains(&id) {
                            ids.push(id);
                        }
                    } else {
                        omitted = true;
                    }
                }
            }
        }
        _ => return Err(bad_response()),
    }
    // Search results are listed as sources, but do not imply field-level support.
    if let Some(results) = value.get("results").filter(|v| !v.is_null()) {
        let results = results.as_array().ok_or_else(bad_response)?;
        if results.len() > 32 {
            return Err(bad_response());
        }
        for result in results {
            if add_source(&mut output.sources, result)?.is_none() {
                omitted = true;
            }
        }
    }
    if omitted {
        output
            .warnings
            .push("Some unsafe sources or invalid field-level citations were omitted.".into());
    }
    if fields
        .iter()
        .any(|field| !output.grounding.contains_key(field))
    {
        output.warnings.push("Some fields have no usable Exa grounding. Search results alone do not substantiate those fields.".into());
    }
    if output.sources.is_empty() {
        output
            .warnings
            .push("No usable sources were returned.".into());
    }
    Ok(output)
}

fn add_source(sources: &mut Vec<Source>, value: &Value) -> Result<Option<usize>> {
    let Some(url) = value.get("url").and_then(Value::as_str).and_then(safe_url) else {
        return Ok(None);
    };
    if let Some(source) = sources.iter().find(|s| s.url == url) {
        return Ok(Some(source.id));
    }
    if sources.len() >= 32 {
        return Err(bad_response());
    }
    let title = value
        .get("title")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(&url);
    if title.len() > 4096 || title.contains('\0') {
        return Err(bad_response());
    }
    let id = sources.len() + 1;
    sources.push(Source {
        id,
        title: title.into(),
        url,
    });
    Ok(Some(id))
}

pub(super) async fn status(State(app): State<App>) -> Json<Value> {
    Json(
        json!({"configured": app.research.is_some(), "maxQueryBytes": MAX_QUERY,
        "timeoutSeconds": TIMEOUT.as_secs(), "message": if app.research.is_some() {
            "Exa configuration is present; availability is checked only on submission."
        } else { SETUP }}),
    )
}
pub(super) async fn research(
    State(app): State<App>,
    Json(input): Json<Input>,
) -> Result<Json<Output>> {
    validate_query(&input.query)?;
    app.research
        .as_ref()
        .ok_or_else(|| Error(StatusCode::SERVICE_UNAVAILABLE, SETUP.into()))?
        .run(&input.query)
        .await
        .map(Json)
}

#[cfg(test)]
#[path = "research_tests.rs"]
mod tests;

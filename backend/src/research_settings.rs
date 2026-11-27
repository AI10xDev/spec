//! Independent server-wide Exa settings. Secrets never enter model profiles or views.
use crate::{App, Error, Result, invalid, research::Research, settings::PrivateFile};
use axum::{
    Json,
    extract::{State, rejection::JsonRejection},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tokio::sync::Semaphore;

pub const MAX_BODY: usize = 16 * 1024;

#[derive(Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DomainMode {
    #[default]
    Any,
    Include,
    Exclude,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preferences {
    pub enabled: bool,
    pub num_results: u8,
    pub domain_mode: DomainMode,
    pub domains: Vec<String>,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            enabled: true,
            num_results: 10,
            domain_mode: DomainMode::Any,
            domains: vec![],
        }
    }
}

impl Preferences {
    fn validate(mut self) -> Result<Self> {
        if !(1..=10).contains(&self.num_results) {
            return Err(invalid("Returned pages must be an integer from 1 to 10"));
        }
        let mut domains = Vec::new();
        for raw in &self.domains {
            let domain = raw.trim().to_ascii_lowercase();
            if domain.len() > 253
                || !domain.contains('.')
                || domain.parse::<std::net::IpAddr>().is_ok()
                || !domain
                    .rsplit('.')
                    .next()
                    .is_some_and(|s| s.bytes().any(|c| c.is_ascii_alphabetic()))
                || domain.split('.').any(|label| {
                    label.is_empty()
                        || label.len() > 63
                        || label.starts_with('-')
                        || label.ends_with('-')
                        || !label
                            .bytes()
                            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
                })
            {
                return Err(invalid(
                    "Use dotted plain DNS names, not URLs, IP addresses, ports, paths or wildcards",
                ));
            }
            if !domains.contains(&domain) {
                domains.push(domain);
                if domains.len() > 20 {
                    return Err(invalid("Use at most 20 distinct plain domain names"));
                }
            }
        }
        if (self.domain_mode == DomainMode::Any) != domains.is_empty() {
            return Err(invalid(
                "Any domain requires an empty list; include or exclude requires domain names",
            ));
        }
        self.domains = domains;
        Ok(self)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Input {
    preferences: Preferences,
    #[serde(default, deserialize_with = "crate::settings::present_key")]
    api_key: Option<String>,
}

// Deliberately not Debug. Only this persisted type contains the saved override.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Saved {
    preferences: Preferences,
    api_key: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub preferences: Preferences,
    pub has_api_key: bool,
    has_saved_key: bool,
    key_source: &'static str,
    preference_source: &'static str,
}

struct Active {
    saved: Option<Saved>,
    runtime: Option<Research>,
}

pub struct Store {
    file: PrivateFile,
    active: Mutex<Active>,
    environment: Option<Research>,
    slots: Arc<Semaphore>,
    blocked: bool,
}

fn local_error() -> Error {
    Error(StatusCode::SERVICE_UNAVAILABLE,
        "Exa settings unavailable. An operator must repair private Exa settings storage and restart; no fallback key is used for unsafe or malformed storage.".into())
}

impl Store {
    // Failure disables only research, never silently selecting another billable key.
    pub fn open(file: PrivateFile, environment: Option<Research>) -> Self {
        let slots = environment
            .as_ref()
            .map(|r| r.slots.clone())
            .unwrap_or_else(|| Arc::new(Semaphore::new(1)));
        let mut store = Self {
            file,
            active: Mutex::new(Active {
                saved: None,
                runtime: None,
            }),
            environment,
            slots,
            blocked: false,
        };
        let loaded: Result<Active> = (|| {
            let saved: Option<Saved> = match store.file.load()? {
                Some(bytes) => serde_json::from_slice(&bytes).map_err(|_| local_error())?,
                None => None,
            };
            let saved = saved
                .map(|mut s| -> Result<Saved> {
                    s.preferences = s.preferences.validate()?;
                    if let Some(key) = &s.api_key {
                        if key.is_empty() {
                            return Err(local_error());
                        }
                        Research::configured(Some(key)).map_err(|_| local_error())?;
                    }
                    Ok(s)
                })
                .transpose()?;
            let runtime = store.runtime_for(saved.as_ref())?;
            Ok(Active { saved, runtime })
        })();
        match loaded {
            Ok(active) => *store.active.lock().unwrap() = active,
            Err(_) => store.blocked = true,
        }
        store
    }

    fn runtime_for(&self, saved: Option<&Saved>) -> Result<Option<Research>> {
        let preferences = saved.map(|s| s.preferences.clone()).unwrap_or_default();
        let mut runtime = if let Some(key) = saved.and_then(|s| s.api_key.as_deref()) {
            Research::configured(Some(key)).map_err(invalid)?
        } else {
            self.environment.clone()
        };
        if let Some(research) = &mut runtime {
            research.slots = self.slots.clone();
            research.preferences = preferences.clone();
        }
        Ok(if preferences.enabled { runtime } else { None })
    }

    pub fn snapshot(&self) -> Option<Research> {
        self.active.lock().unwrap().runtime.clone()
    }

    fn view_of(&self, active: &Active) -> View {
        let has_saved_key = active.saved.as_ref().is_some_and(|s| s.api_key.is_some());
        View {
            preferences: active
                .saved
                .as_ref()
                .map(|s| s.preferences.clone())
                .unwrap_or_default(),
            has_api_key: has_saved_key || self.environment.is_some(),
            has_saved_key,
            key_source: if has_saved_key {
                "settings"
            } else if self.environment.is_some() {
                "environment"
            } else {
                "none"
            },
            preference_source: if active.saved.is_some() {
                "settings"
            } else {
                "defaults"
            },
        }
    }

    pub fn view(&self) -> Result<View> {
        if self.blocked {
            return Err(local_error());
        }
        Ok(self.view_of(&self.active.lock().unwrap()))
    }

    fn update(&self, input: Option<Input>) -> Result<View> {
        if self.blocked {
            return Err(local_error());
        }
        let mut active = self.active.lock().unwrap();
        let saved = input
            .map(|input| -> Result<Saved> {
                let key = input
                    .api_key
                    .or_else(|| active.saved.as_ref().and_then(|s| s.api_key.clone()));
                let api_key = key.filter(|s| !s.is_empty());
                // Validate even while disabled, before persistence/publication.
                if let Some(key) = &api_key {
                    Research::configured(Some(key)).map_err(invalid)?;
                }
                Ok(Saved {
                    preferences: input.preferences.validate()?,
                    api_key,
                })
            })
            .transpose()?;
        let runtime = self.runtime_for(saved.as_ref())?;
        self.file
            .persist(&serde_json::to_vec(&saved).map_err(|_| local_error())?)
            .map_err(|_| local_error())?;
        *active = Active { saved, runtime };
        Ok(self.view_of(&active))
    }
}

pub async fn get(State(app): State<App>) -> Result<Json<View>> {
    app.research.view().map(Json)
}
pub async fn put(
    State(app): State<App>,
    input: std::result::Result<Json<Input>, JsonRejection>,
) -> Result<Json<View>> {
    let Json(input) =
        input.map_err(|error| Error(error.status(), "Invalid Exa settings request".into()))?;
    change(app.research, Some(input)).await
}
pub async fn delete(State(app): State<App>) -> Result<Json<View>> {
    change(app.research, None).await
}
async fn change(store: Arc<Store>, input: Option<Input>) -> Result<Json<View>> {
    tokio::task::spawn_blocking(move || store.update(input))
        .await
        .map_err(|_| local_error())?
        .map(Json)
}

#[cfg(test)]
#[path = "research_settings_tests.rs"]
mod tests;

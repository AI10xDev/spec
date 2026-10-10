use crate::{App, Error, Result, realtime};
use axum::{Json, extract::State, http::StatusCode};
use realtime::{Input, Output, network_error, provider_error};
use reqwest::{
    Client, Url,
    header::{AUTHORIZATION, CONTENT_TYPE, HeaderValue},
};
use serde::Deserialize;
use serde_json::json;
use std::{sync::Arc, time::Duration};
use tokio::sync::Semaphore;

const TIMEOUT: Duration = Duration::from_secs(30);
// Azure echoes the session: 32 KiB of context can expand 7x (224 KiB) through
// nested JSON escaping. Leave room for the fixed prompt, session and metadata.
const MAX_SECRET_RESPONSE: usize = 512 * 1024;

#[derive(Clone)]
pub struct AzureRealtime {
    client: Client,
    origin: String,
    key: HeaderValue,
    deployment: String,
    slots: Arc<Semaphore>,
    timeout: Duration,
}

impl AzureRealtime {
    pub fn from_env() -> std::result::Result<Option<Self>, &'static str> {
        let get = |name| match std::env::var(name) {
            Ok(value) => Ok(Some(value)),
            Err(std::env::VarError::NotPresent) => Ok(None),
            Err(_) => Err("Azure Realtime configuration must be valid UTF-8"),
        };
        Self::configured(
            get("AZURE_OPENAI_REALTIME_ENDPOINT")?.as_deref(),
            get("AZURE_OPENAI_REALTIME_API_KEY")?.as_deref(),
            get("AZURE_OPENAI_REALTIME_DEPLOYMENT")?.as_deref(),
        )
    }

    fn configured(
        endpoint: Option<&str>,
        key: Option<&str>,
        deployment: Option<&str>,
    ) -> std::result::Result<Option<Self>, &'static str> {
        if endpoint.is_none() && key.is_none() && deployment.is_none() {
            return Ok(None);
        }
        let (Some(endpoint), Some(key), Some(deployment)) = (endpoint, key, deployment) else {
            return Err(
                "Set AZURE_OPENAI_REALTIME_ENDPOINT, AZURE_OPENAI_REALTIME_API_KEY, and AZURE_OPENAI_REALTIME_DEPLOYMENT together",
            );
        };
        let url = Url::parse(endpoint).map_err(|_| "Invalid AZURE_OPENAI_REALTIME_ENDPOINT URL")?;
        let origin = url.origin().ascii_serialization();
        let resource = url
            .host_str()
            .and_then(|host| host.strip_suffix(".openai.azure.com"));
        // Accept only canonical public Azure resource origins, not proxy URLs or
        // URL-parser-normalized paths/userinfo that could disguise configuration mistakes.
        if url.scheme() != "https"
            || url.port().is_some()
            || (endpoint != origin && endpoint != format!("{origin}/"))
            || !resource.is_some_and(|name| {
                !name.is_empty()
                    && name.len() <= 63
                    && !name.starts_with('-')
                    && !name.ends_with('-')
                    && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            })
        {
            return Err(
                "AZURE_OPENAI_REALTIME_ENDPOINT must be a canonical HTTPS resource origin https://RESOURCE.openai.azure.com, optionally ending in / (no credentials, port, path, query, or fragment)",
            );
        }
        if key.is_empty() || key.len() > 4096 || !key.bytes().all(|b| b.is_ascii_graphic()) {
            return Err(
                "AZURE_OPENAI_REALTIME_API_KEY must be nonempty ASCII without whitespace (maximum 4096 bytes)",
            );
        }
        let mut key =
            HeaderValue::from_str(key).map_err(|_| "Invalid AZURE_OPENAI_REALTIME_API_KEY")?;
        key.set_sensitive(true);
        if deployment.is_empty()
            || deployment.len() > 128
            || !deployment
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
            || matches!(deployment, "." | "..")
        {
            return Err(
                "AZURE_OPENAI_REALTIME_DEPLOYMENT must be a deployment name (maximum 128 ASCII bytes)",
            );
        }
        let client = Client::builder()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(TIMEOUT)
            .build()
            .map_err(|_| "Could not initialize Azure Realtime HTTPS client")?;
        Ok(Some(Self {
            client,
            origin,
            key,
            deployment: deployment.into(),
            slots: Arc::new(Semaphore::new(4)),
            timeout: TIMEOUT,
        }))
    }
}

pub async fn call(State(app): State<App>, Json(mut input): Json<Input>) -> Result<Json<Output>> {
    realtime::validate_input(&input)?;
    let provider = app.azure_realtime.as_ref().ok_or_else(|| {
        Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Azure OpenAI Realtime is not configured".into(),
        )
    })?;
    let _permit = provider.slots.try_acquire().map_err(|_| {
        Error(
            StatusCode::TOO_MANY_REQUESTS,
            "Realtime concurrency limit reached; try again shortly".into(),
        )
    })?;
    // One deadline and one permit cover both requests, including response reads.
    tokio::time::timeout(provider.timeout, async {
        let session = realtime::session(&mut input, &provider.deployment);
        let response = provider
            .client
            .post(format!(
                "{}/openai/v1/realtime/client_secrets",
                provider.origin
            ))
            .header("api-key", provider.key.clone())
            .json(&json!({"session": session}))
            .send()
            .await
            .map_err(network_error)?;
        #[derive(Deserialize)]
        struct Secret {
            value: String,
        }
        let bytes = realtime::response_bytes(response, MAX_SECRET_RESPONSE).await?;
        let secret: Secret = serde_json::from_slice(&bytes).map_err(|_| provider_error())?;
        if secret.value.is_empty()
            || secret.value.len() > 4096
            || !secret.value.bytes().all(|b| b.is_ascii_graphic())
        {
            return Err(provider_error());
        }
        let mut bearer = HeaderValue::from_str(&format!("Bearer {}", secret.value))
            .map_err(|_| provider_error())?;
        bearer.set_sensitive(true);
        let response = provider
            .client
            .post(format!("{}/openai/v1/realtime/calls", provider.origin))
            .header(AUTHORIZATION, bearer)
            .header(CONTENT_TYPE, "application/sdp")
            .body(input.sdp)
            .send()
            .await
            .map_err(network_error)?;
        realtime::answer(response).await
    })
    .await
    .map_err(|_| realtime::timeout_error())?
}

#[cfg(test)]
#[path = "azure_realtime_tests.rs"]
mod tests;

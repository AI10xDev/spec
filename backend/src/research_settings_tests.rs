use super::*;
use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
};
use tower::ServiceExt;

fn input(key: Option<&str>) -> Input {
    Input {
        preferences: Preferences::default(),
        api_key: key.map(str::to_owned),
    }
}
fn fixture() -> (tempfile::TempDir, std::path::PathBuf, Store) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("private/research.json");
    let file = PrivateFile::open(
        path.clone(),
        &dir.path().join("workspace"),
        &dir.path().join("ui"),
    )
    .ok()
    .unwrap();
    let env = Research::configured(Some("environment-secret")).unwrap();
    (dir, path, Store::open(file, env))
}
fn reopen(dir: &std::path::Path, path: std::path::PathBuf) -> Store {
    Store::open(
        PrivateFile::open(path, &dir.join("workspace"), &dir.join("ui"))
            .ok()
            .unwrap(),
        Research::configured(Some("environment-secret")).unwrap(),
    )
}
fn view(store: &Store) -> Value {
    serde_json::to_value(store.view().ok().unwrap()).unwrap()
}

#[test]
fn persistence_precedence_retention_removal_disable_and_reset() {
    let (dir, path, store) = fixture();
    assert_eq!(view(&store)["keySource"], "environment");
    let old = store.snapshot().unwrap();
    store.update(Some(input(None))).ok().unwrap();
    assert!(
        !fs::read_to_string(&path)
            .unwrap()
            .contains("environment-secret")
    );
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        fs::metadata(path.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    store
        .update(Some(input(Some("saved-secret"))))
        .ok()
        .unwrap();
    assert_eq!(view(&store)["keySource"], "settings");
    assert!(!view(&store).to_string().contains("secret"));
    assert_eq!(
        view(&reopen(dir.path(), path.clone()))["keySource"],
        "settings"
    );
    store.update(Some(input(None))).ok().unwrap();
    assert!(fs::read_to_string(&path).unwrap().contains("saved-secret"));
    let mut disabled = input(None);
    disabled.preferences.enabled = false;
    store.update(Some(disabled)).ok().unwrap();
    assert!(store.snapshot().is_none());
    assert_eq!(view(&store)["hasApiKey"], true);
    store.update(Some(input(Some("")))).ok().unwrap();
    assert_eq!(view(&store)["keySource"], "environment");
    store.update(None).ok().unwrap();
    assert_eq!(view(&store)["preferenceSource"], "defaults");
    assert_eq!(fs::read_to_string(&path).unwrap(), "null");
    assert!(Arc::ptr_eq(&old.slots, &store.snapshot().unwrap().slots));
}

#[test]
fn generations_share_one_slot_and_capture_preferences() {
    let (_dir, _path, store) = fixture();
    let old = store.snapshot().unwrap();
    let permit = old.slots.try_acquire().unwrap();
    for key in [Some("rotated-secret"), Some(""), None] {
        let mut next = input(key);
        next.preferences.num_results = 2;
        next.preferences.domain_mode = DomainMode::Include;
        next.preferences.domains = vec![" EXAMPLE.ORG ".into(); 21];
        store.update(Some(next)).ok().unwrap();
        let snapshot = store.snapshot().unwrap();
        assert_eq!(snapshot.preferences.num_results, 2);
        assert_eq!(snapshot.preferences.domains, ["example.org"]);
        assert!(snapshot.slots.try_acquire().is_err());
    }
    assert_eq!(old.preferences.num_results, 10);
    store.update(None).ok().unwrap();
    assert!(store.snapshot().unwrap().slots.try_acquire().is_err());
    drop(permit);
    assert!(store.snapshot().unwrap().slots.try_acquire().is_ok());
}

#[test]
fn validation_is_bounded_and_errors_do_not_echo_inputs() {
    let (_dir, path, store) = fixture();
    store.update(Some(input(Some("good-secret")))).ok().unwrap();
    let before = fs::read(&path).unwrap();
    for domain in [
        "https://example.org",
        "x@example.org",
        "*.example.org",
        "example.org/path",
        "example.org:443",
        "127.0.0.1",
        "[::1]",
        "localhost",
        "a..com",
        "-x.com",
        "x-.com",
        "x.123",
        "x.é",
        "x. com",
        "x.com\nsecret",
        "x.com.",
    ] {
        let mut next = input(None);
        next.preferences.domain_mode = DomainMode::Include;
        next.preferences.domains = vec![domain.into()];
        let error = store.update(Some(next)).err().unwrap();
        assert_eq!(error.0, StatusCode::BAD_REQUEST);
        assert!(!error.1.contains(domain));
    }
    for n in [0, 11, 255] {
        let mut next = input(None);
        next.preferences.num_results = n;
        assert!(store.update(Some(next)).is_err());
    }
    for key in ["bad secret", "secret\n", "é", &"x".repeat(4097)] {
        assert!(store.update(Some(input(Some(key)))).is_err());
    }
    for domains in [vec!["example.org".into()], vec![]] {
        let mut next = input(None);
        next.preferences.domain_mode = if domains.is_empty() {
            DomainMode::Exclude
        } else {
            DomainMode::Any
        };
        next.preferences.domains = domains;
        assert!(store.update(Some(next)).is_err());
    }
    let mut next = input(None);
    next.preferences.domain_mode = DomainMode::Exclude;
    next.preferences.domains = (0..21).map(|i| format!("d{i}.org")).collect();
    assert!(store.update(Some(next)).is_err());
    for domain in [
        format!("{}.org", "x".repeat(64)),
        format!(
            "{}.{}.{}.{}.org",
            "x".repeat(63),
            "x".repeat(63),
            "x".repeat(63),
            "x".repeat(63)
        ),
    ] {
        let mut next = input(None);
        next.preferences.domain_mode = DomainMode::Include;
        next.preferences.domains = vec![domain];
        assert!(store.update(Some(next)).is_err());
    }
    assert_eq!(fs::read(&path).unwrap(), before);
    assert_eq!(view(&store)["keySource"], "settings");
    for n in [1, 10] {
        let mut next = input(None);
        next.preferences.num_results = n;
        next.preferences.domain_mode = DomainMode::Exclude;
        next.preferences.domains = vec!["xn--bcher-kva.example".into()];
        assert!(store.update(Some(next)).is_ok());
    }
}

#[test]
fn corrupt_unsafe_storage_fails_closed_and_cannot_be_overwritten() {
    let (dir, path, store) = fixture();
    store
        .update(Some(input(Some("saved-secret"))))
        .ok()
        .unwrap();
    for bytes in [
        "broken secret",
        "{}",
        r#"{"preferences":{"enabled":true,"numResults":11,"domainMode":"any","domains":[]},"apiKey":null}"#,
    ] {
        fs::write(&path, bytes).unwrap();
        let blocked = reopen(dir.path(), path.clone());
        assert!(blocked.snapshot().is_none());
        assert!(blocked.view().is_err());
        assert!(blocked.update(None).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), bytes);
    }
    fs::write(&path, "null").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(reopen(dir.path(), path.clone()).view().is_err());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let target = path.with_extension("target");
    fs::rename(&path, &target).unwrap();
    symlink(&target, &path).unwrap();
    assert!(reopen(dir.path(), path.clone()).view().is_err());
    fs::remove_file(&path).unwrap();
    fs::hard_link(&target, &path).unwrap();
    assert!(reopen(dir.path(), path.clone()).view().is_err());
    assert!(
        store
            .update(Some(input(Some("replacement-secret"))))
            .is_err()
    );
    assert_eq!(view(&store)["keySource"], "settings");
    assert!(store.snapshot().is_some()); // failed persistence never publishes
    assert_eq!(fs::read_to_string(&target).unwrap(), "null");
}

#[tokio::test]
async fn routes_auth_redaction_malformed_limits_and_independence() {
    let root = tempfile::tempdir().unwrap();
    let app = crate::tests::app(root.path());
    for method in ["GET", "PUT", "DELETE"] {
        let response = crate::router(app.clone())
            .oneshot(
                Request::builder()
                    .uri("/api/settings/research")
                    .method(method)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
    let prefs = json!({"enabled": true, "numResults": 3, "domainMode": "include", "domains": ["Example.org"]});
    let mut cases = vec![(
        json!({"preferences": prefs, "apiKey": "route-secret"}).to_string(),
        200,
    )];
    for body in [
        json!({"preferences": prefs, "apiKey": null}),
        json!({"preferences": prefs, "apiKey": 42}),
        json!({"preferences": prefs, "unknown": "secret"}),
        json!({"preferences": {"enabled":true,"numResults":1.5,"domainMode":"any","domains":[]}}),
        json!({"preferences": {"enabled":true,"numResults":"3","domainMode":"any","domains":[]}}),
    ] {
        cases.push((body.to_string(), 422));
    }
    cases.push(("{secret".into(), 400));
    cases.push((json!({"apiKey": "x".repeat(MAX_BODY)}).to_string(), 413));
    for (body, status) in cases {
        let response = crate::router(app.clone())
            .oneshot(
                Request::builder()
                    .uri("/api/settings/research")
                    .method("PUT")
                    .header("authorization", "Bearer test-token")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), status);
        assert_eq!(response.headers()["cache-control"], "no-store");
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        assert!(!String::from_utf8_lossy(&bytes).contains("secret"));
    }
    assert!(app.settings.profile().is_none());
    assert!(app.jobs.lock().unwrap().is_empty());
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
    assert_eq!(view(&app.research)["preferences"]["numResults"], 3);
    for method in ["GET", "DELETE"] {
        let response = crate::router(app.clone())
            .oneshot(
                Request::builder()
                    .uri("/api/settings/research")
                    .method(method)
                    .header("authorization", "Bearer test-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["cache-control"], "no-store");
    }
    assert!(app.research.snapshot().is_none());
}

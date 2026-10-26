use super::*;

pub(super) const MAX_REPORT: usize = 8 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Input {
    name: String,
    run_id: Option<String>,
}

#[derive(Serialize)]
pub(super) struct Analysis {
    report: Option<Output>,
    runs: Vec<remote::RetainedRun>,
    warnings: Vec<String>,
}

pub(super) async fn report(
    State(app): State<App>,
    Json(input): Json<Input>,
) -> Result<Json<Analysis>> {
    let Input { name, run_id } = input;
    validate(&name)?;
    if let Some(id) = &run_id
        && !Uuid::parse_str(id).is_ok_and(|uuid| uuid.to_string() == *id)
    {
        return Err(invalid("Invalid run ID"));
    }
    // Apply the same workspace file validation as the existing retained routes.
    read(&app.root, &name)?;
    let associated = recovery::latest(&app, &name)?;
    let mut result = Analysis {
        report: None,
        runs: Vec::new(),
        warnings: Vec::new(),
    };
    if app.remote.is_some() || associated.is_some() || run_id.is_some() {
        let remote = retained_remote(&app, &name)?;
        if let Some(id) = run_id.or(associated) {
            result.report = Some(
                remote
                    .retained(&name, Some(&id), true)
                    .await
                    .map_err(|error| Error(StatusCode::BAD_GATEWAY, error))?,
            );
        } else {
            let listed: remote::RetainedRuns = remote
                .retained(&name, None, true)
                .await
                .map_err(|error| Error(StatusCode::BAD_GATEWAY, error))?;
            result.runs = listed.runs;
            if listed.truncated {
                result.warnings.push(
                    "Retained run choices are incomplete because the lookup limit was reached."
                        .into(),
                );
            }
            if !result.runs.is_empty() || listed.truncated {
                result.warnings.push(
                    "No associated run; select a retained run to evaluate its report.".into(),
                );
                return Ok(Json(result));
            }
        }
    }
    if result.report.is_none() {
        let path = app.root.join(format!("{name}.out"));
        let file = match OpenOptions::new()
            .read(true)
            .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
            .open(path)
        {
            Ok(file) => Some(file),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        if let Some(mut file) = file {
            let before = file.metadata()?;
            if !before.is_file() {
                return Err(invalid("Output must be a regular file"));
            }
            let mut bytes = Vec::new();
            (&mut file)
                .take((MAX_REPORT + 1) as u64)
                .read_to_end(&mut bytes)?;
            let after = file.metadata()?;
            // Exact-cap files may already have lost bytes in the remote supervisor.
            let truncated = bytes.len() >= MAX_REPORT
                || before.len() != after.len()
                || before.modified()? != after.modified()?;
            bytes.truncate(MAX_REPORT);
            let output = String::from_utf8_lossy(&bytes);
            let truncated = truncated || matches!(output, std::borrow::Cow::Owned(_));
            result.report = Some(Output {
                id: "local".into(),
                name,
                status: "snapshot".into(),
                output: output.into_owned(),
                truncated,
                recoverable: false,
                continuable: false,
            });
            result.warnings.push("Local workspace .out snapshot; not associated with a verified remote session or terminal status.".into());
        }
    }
    if let Some(report) = &result.report {
        if report.truncated {
            result.warnings.push("Report is incomplete: reached the 8 MiB limit, changed during the read, or contained invalid UTF-8. Skip definitive evaluation.".into());
        }
        if report.status == "running" || report.status.starts_with("unknown") {
            result.warnings.push("Active or unknown-status report snapshot; output may still change. Skip definitive evaluation.".into());
        }
    } else {
        result
            .warnings
            .push("No prior output found; this is not proof that the spec has never run.".into());
    }
    Ok(Json(result))
}

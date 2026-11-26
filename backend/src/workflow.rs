use super::*;

pub(super) fn validate(job: &Job) -> Result<()> {
    let Some(stage) = job.stage.as_deref() else {
        if job.snapshot.is_some() || job.build_result.is_some() || job.approved_handoff.is_some() {
            return Err(invalid("Workflow metadata requires an explicit stage"));
        }
        return Ok(());
    };
    if !matches!(stage, "builder" | "integrator")
        || job.repository_save
        || job.optimization
        || job.snapshot.as_ref().is_none_or(|snapshot| {
            snapshot.trim().is_empty() || snapshot.len() > MAX_BUILD_SPEC || snapshot.contains('\0')
        })
        || (stage == "builder" && job.approved_handoff.is_some())
        || (stage == "integrator" && job.approved_handoff.is_none())
    {
        return Err(invalid("Invalid staged build metadata"));
    }
    if let Some(result) = &job.build_result {
        result.validate(stage).map_err(|error| invalid(&error))?;
    }
    if let Some(handoff) = &job.approved_handoff {
        handoff
            .validate("builder")
            .map_err(|error| invalid(&error))?;
    }
    Ok(())
}

pub(super) fn report(job: &Job) -> Option<String> {
    let stage = job.stage.as_deref()?;
    let result = job.build_result.as_ref()?;
    (job.status == "completed" && !job.recover && result.validate(stage).is_ok())
        .then(|| result.report.clone())
}

// Callers hold app.files before app.jobs, so document and queue checks agree
// with admission. Approval retains both locks through child registration.
pub(super) fn approvable(app: &App, job: &Job) -> Result<bool> {
    if app.performance
        || job.stage.as_deref() != Some("builder")
        || job.attached
        || job.recover
        || job.persistence_error.is_some()
        || job.dirty
        || validate(job).is_err()
        || report(job).is_none()
        || app
            .remote
            .as_ref()
            .is_none_or(|remote| remote.identity() != job.remote_identity)
    {
        return Ok(false);
    }
    if !read(&app.root, &job.name)
        .is_ok_and(|document| job.snapshot.as_deref() == Some(document.content.as_str()))
        || queued_builds::pending(app, &job.id)?
    {
        return Ok(false);
    }
    Ok(recovery::latest(app, &job.name)?.as_deref() == Some(&job.id))
}

pub(super) fn require_approval(app: &App, job: &Job) -> Result<()> {
    if !approvable(app, job)? {
        return Err(Error(StatusCode::CONFLICT,
            "Only the latest successful builder with a durable validated report on this remote, an unchanged saved spec, and no pending queued build can be approved; active, legacy, stale, or already approved runs cannot be approved".into()));
    }
    // Re-read the authoritative record before accepting, including its permissions.
    let saved = recovery::load(app, &job.id)?;
    if saved.recover
        || saved.status != "completed"
        || report(&saved) != report(job)
        || saved.snapshot != job.snapshot
        || saved.stage != job.stage
        || saved.remote_identity != job.remote_identity
    {
        return Err(Error(
            StatusCode::CONFLICT,
            "Builder checkpoint is not durable".into(),
        ));
    }
    Ok(())
}

// A successful process exit is insufficient. Transport errors remain unresolved
// for retry; a rejected result is terminal failure, never an approvable report.
pub(super) async fn result(
    remote: &Remote,
    id: &str,
    name: &str,
    stage: Option<&str>,
    status: &mut String,
) -> Option<remote::BuildResult> {
    let stage = stage.filter(|_| status == "completed")?;
    match remote.build_result(id, name).await.and_then(|result| {
        result.validate(stage)?;
        Ok(result)
    }) {
        Ok(result) => Some(result),
        Err(error) => {
            *status = if error.starts_with("invalid ")
                || error == "remote build result response exceeded limit"
                || error
                    .contains("Missing, unsafe, mismatched, or invalid successful build result.")
            {
                format!("failed (invalid or missing build result: {error})")
            } else {
                format!("unknown (build result unavailable: {error})")
            };
            None
        }
    }
}

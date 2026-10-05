use super::*;
use std::os::unix::fs::{DirBuilderExt, MetadataExt};

const DIRECTORY: &str = ".spec-output";
const MAX_RECORD: usize = MAX_OUTPUT * 4 + 64 * 1024;

fn valid_id(id: &str) -> Result<()> {
    if !Uuid::parse_str(id).is_ok_and(|uuid| uuid.to_string() == id) {
        return Err(invalid("Invalid run ID"));
    }
    Ok(())
}

// Anchor all subsequent access to the opened directory, not a re-resolved path.
// The workspace is already protected by the server's exclusive lock.
fn directory(app: &App, create: bool) -> Result<File> {
    let path = app.root.join(DIRECTORY);
    if create {
        match fs::DirBuilder::new().mode(0o700).create(&path) {
            Ok(()) => {
                File::open(&app.root)?.sync_all()?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.into()),
        }
    }
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_DIRECTORY | nix::libc::O_NOFOLLOW)
        .open(path)?;
    private(&file.metadata()?, true)?;
    Ok(file)
}

fn private(metadata: &fs::Metadata, directory: bool) -> Result<()> {
    if metadata.uid() != unsafe { nix::libc::geteuid() }
        || metadata.permissions().mode() & 0o777 != if directory { 0o700 } else { 0o600 }
        || (!directory && (!metadata.is_file() || metadata.nlink() != 1))
    {
        return Err(Error(StatusCode::INTERNAL_SERVER_ERROR,
            "Run storage must be owned, private (0700 directory, 0600 regular files), and not linked".into()));
    }
    Ok(())
}

fn path(directory: &File, name: &str) -> PathBuf {
    use std::os::fd::AsRawFd;
    PathBuf::from(format!("/proc/self/fd/{}", directory.as_raw_fd())).join(name)
}

fn bytes(directory: &File, name: &str, limit: usize) -> Result<Vec<u8>> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
        .open(path(directory, name))?;
    let metadata = file.metadata()?;
    private(&metadata, false)?;
    if metadata.len() > limit as u64 {
        return Err(invalid("Run record exceeds size limit"));
    }
    let mut bytes = Vec::new();
    file.take((limit + 1) as u64).read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(invalid("Run record exceeds size limit"));
    }
    Ok(bytes)
}

fn atomic(directory: &File, name: &str, bytes: &[u8]) -> Result<()> {
    // Refuse unsafe pre-existing destinations rather than silently repairing them.
    match fs::symlink_metadata(path(directory, name)) {
        Ok(metadata) => private(&metadata, false)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    let mut temp = tempfile::NamedTempFile::new_in(path(directory, ""))?;
    temp.write_all(bytes)?;
    temp.as_file().sync_all()?;
    temp.persist(path(directory, name))
        .map_err(|e| Error::from(e.error))?;
    directory.sync_all()?;
    Ok(())
}

pub(super) fn persist(app: &App, job: &Job) -> Result<()> {
    valid_id(&job.id)?;
    let directory = directory(app, true)?;
    let data = serde_json::to_vec(job)
        .map_err(|e| Error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if data.len() > MAX_RECORD {
        return Err(invalid("Run record exceeds size limit"));
    }
    atomic(&directory, &format!("{}.json", job.id), &data)
}

fn latest_name(name: &str) -> String {
    format!("latest-{:x}", Sha256::digest(name.as_bytes()))
}

pub(super) fn set_latest(app: &App, job: &Job) -> Result<()> {
    atomic(
        &directory(app, true)?,
        &latest_name(&job.name),
        job.id.as_bytes(),
    )
}

pub(super) fn latest(app: &App, name: &str) -> Result<Option<String>> {
    validate(name)?;
    let result = (|| bytes(&directory(app, false)?, &latest_name(name), 36))();
    let data = match result {
        Ok(data) => data,
        Err(Error(StatusCode::NOT_FOUND, _)) => return Ok(None),
        Err(e) => return Err(e),
    };
    let id = String::from_utf8(data).map_err(|_| invalid("Invalid latest run record"))?;
    valid_id(&id)?;
    let job = load(app, &id).map_err(|e| {
        Error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Latest run record could not be read: {}", e.1),
        )
    })?;
    if job.name != name {
        return Err(invalid("Latest run filename mismatch"));
    }
    Ok(Some(id))
}

fn load(app: &App, id: &str) -> Result<Job> {
    valid_id(id)?;
    let data = bytes(&directory(app, false)?, &format!("{id}.json"), MAX_RECORD)?;
    let mut job: Job =
        serde_json::from_slice(&data).map_err(|e| invalid(&format!("Invalid run record: {e}")))?;
    validate(&job.name)?;
    if job.id != id
        || job.output.len() > MAX_OUTPUT
        || job.status.len() > 8192
        || job.remote_identity.len() != 64
        || !job.remote_identity.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(invalid("Invalid run record"));
    }
    if job.recover {
        job.status = "detached (backend restarted)".into();
    }
    Ok(job)
}

pub(super) fn initialize(app: &App) -> Result<()> {
    let mut initialized = app.recovered.lock().unwrap();
    if *initialized {
        return Ok(());
    }
    let directory = match directory(app, false) {
        Ok(dir) => dir,
        Err(Error(StatusCode::NOT_FOUND, _)) => {
            *initialized = true;
            return Ok(());
        }
        Err(e) => return Err(e),
    };
    let mut pending = Vec::new();
    for entry in fs::read_dir(path(&directory, ""))? {
        let entry = entry?;
        let filename = entry.file_name();
        let Some(id) = filename
            .to_str()
            .and_then(|name| name.strip_suffix(".json"))
        else {
            continue;
        };
        let job = load(app, id)?;
        if job.recover {
            if pending.len() >= 32 {
                return Err(invalid("Too many unresolved persisted runs"));
            }
            pending.push(job);
        }
    }
    let mut jobs = app.jobs.lock().unwrap();
    for job in pending {
        if !jobs.iter().any(|existing| existing.id == job.id) {
            jobs.push(job);
        }
    }
    *initialized = true;
    Ok(())
}

pub(super) fn restore(app: &App, id: &str) -> Result<()> {
    valid_id(id)?;
    let mut jobs = app.jobs.lock().unwrap();
    if !jobs.iter().any(|job| job.id == id) {
        let job = load(app, id)?;
        if jobs.len() >= 32
            && let Some(index) = jobs.iter().position(|job| !job.recover)
        {
            jobs.remove(index);
        }
        jobs.push(job);
    }
    Ok(())
}

pub(super) fn checkpoint(app: &App, id: &str) {
    let mut jobs = app.jobs.lock().unwrap();
    if let Some(job) = jobs.iter_mut().find(|job| job.id == id)
        && job.dirty
    {
        match persist(app, job) {
            Ok(()) => {
                job.dirty = false;
                job.persistence_error = None;
            }
            Err(e) => {
                eprintln!("Run {id} persistence: {}", e.1);
                job.persistence_error = Some(e.1);
            }
        }
    }
}

// Caller holds recovery_gate, so concurrent polls/cancels cannot publish stale snapshots.
pub(super) async fn refresh(app: &App, id: &str, cancel: bool) -> Result<()> {
    let retry = app
        .jobs
        .lock()
        .unwrap()
        .iter()
        .any(|job| job.id == id && job.persistence_error.is_some());
    if retry {
        checkpoint(app, id);
    }
    let identity = {
        let jobs = app.jobs.lock().unwrap();
        let job = jobs.iter().find(|job| job.id == id).unwrap();
        if let Some(error) = &job.persistence_error {
            return Err(Error(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Run persistence failed: {error}"),
            ));
        }
        if job.attached || !job.recover {
            return Ok(());
        }
        job.remote_identity.clone()
    };
    let snapshot = match &app.remote {
        Some(remote) if remote.identity() == identity => remote.snapshot(id, cancel).await,
        _ => Err("remote configuration does not match the saved run".into()),
    };
    if cancel && let Err(error) = &snapshot {
        return Err(Error(StatusCode::BAD_GATEWAY, error.clone()));
    }
    let mut jobs = app.jobs.lock().unwrap();
    let job = jobs.iter_mut().find(|job| job.id == id).unwrap();
    let before = (
        job.status.clone(),
        job.output.clone(),
        job.truncated,
        job.recover,
    );
    match snapshot {
        Ok((status, bytes, truncated)) => {
            job.recover = status == "running" || status.starts_with("unknown");
            job.status = status;
            job.output = bytes.into();
            job.truncated = truncated;
        }
        Err(error) => job.status = format!("unavailable ({error})"),
    }
    if before
        != (
            job.status.clone(),
            job.output.clone(),
            job.truncated,
            job.recover,
        )
        || job.dirty
    {
        job.dirty = true;
        match persist(app, job) {
            Ok(()) => {
                job.dirty = false;
                job.persistence_error = None;
            }
            Err(error) => {
                job.persistence_error = Some(error.1.clone());
                return Err(error);
            }
        }
    }
    Ok(())
}

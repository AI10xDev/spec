// SPDX-License-Identifier: MIT OR Apache-2.0

use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};

/// One editor's durable inbox. Dropping it must not interrupt the detached build.
pub struct SpecSession {
    pub(crate) directory: PathBuf,
    sequence: u64,
    // Only one editor may publish to an inbox at a time. The runner has its own claim.
    writer: Option<fs::File>,
}

impl SpecSession {
    fn root() -> PathBuf {
        std::env::var_os("XDG_STATE_HOME")
            .filter(|value| !value.is_empty())
            .map_or_else(
                || {
                    std::env::var_os("HOME").map_or_else(std::env::temp_dir, |home| {
                        PathBuf::from(home).join(".local/state")
                    })
                },
                PathBuf::from,
            )
            .join("spec/sessions")
    }

    pub(crate) fn new() -> io::Result<Self> {
        let root = Self::root();
        fs::create_dir_all(&root)?;
        let timestamp = SystemTime::now().duration_since(UNIX_EPOCH).map_err(io::Error::other)?;
        let directory = root.join(format!("{}-{}", std::process::id(), timestamp.as_nanos()));
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        builder.mode(0o700);
        builder.create(&directory)?;
        let writer = Self::lock(&directory)?;
        Ok(Self { directory, sequence: 0, writer: Some(writer) })
    }

    fn lock(directory: &Path) -> io::Result<fs::File> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let metadata = fs::symlink_metadata(directory)?;
            if !metadata.is_dir()
                || metadata.mode() & 0o777 != 0o700
                || metadata.uid() != crate::sys::user_id()
            {
                return Err(io::Error::other("Expected an owned, private session directory"));
            }
        }
        // Migrated sessions predate the writer lock. Wait for their original editor to exit.
        #[cfg(unix)]
        if let Ok(bytes) = fs::read(directory.join(".legacy-editor-pid"))
            && let Ok(pid) = serde_json::from_slice::<u32>(&bytes)
            && crate::sys::process_exists(pid)
        {
            return Err(io::Error::other("Session is still open in the previous editor"));
        }
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(unix)]
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        let writer = options.open(directory.join(".editor-lock"))?;
        writer.try_lock().map_err(|_| io::Error::other("Session is open in another editor"))?;
        Ok(writer)
    }

    pub(crate) fn remember(&self, spec: &Path, log: &Path) -> io::Result<()> {
        let value = serde_json::json!({
            "file": fs::canonicalize(spec)?,
            "log": fs::canonicalize(log)?,
        });
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        // Every *.json file in the inbox is a prompt, including dotfiles.
        let mut file = options.open(self.directory.join(".editor-state"))?;
        file.write_all(&serde_json::to_vec(&value)?)?;
        file.sync_all()
    }

    pub(crate) fn restore(spec: &Path) -> io::Result<Option<(Self, PathBuf)>> {
        Self::restore_from(&Self::root(), spec)
    }

    fn restore_from(root: &Path, spec: &Path) -> io::Result<Option<(Self, PathBuf)>> {
        let spec = match fs::canonicalize(spec) {
            Ok(spec) => spec,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        let entries = match fs::read_dir(root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        let latest = entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                if !entry.file_type().ok()?.is_dir() {
                    return None;
                }
                let file = entry.path().join(".editor-state");
                let value: serde_json::Value =
                    serde_json::from_slice(&fs::read(&file).ok()?).ok()?;
                if Path::new(value["file"].as_str()?) != spec {
                    return None;
                }
                Some((
                    fs::metadata(file).ok()?.modified().ok()?,
                    entry.path(),
                    PathBuf::from(value["log"].as_str()?),
                ))
            })
            .max_by_key(|(time, _, _)| *time);
        let Some((_, directory, log)) = latest else { return Ok(None) };
        let writer = Self::lock(&directory)?;
        // Accepted and pending files have moved out of the inbox; their names remain reserved.
        // Follow the runner's move order so an in-flight file cannot evade the scan.
        let sequence = ["", ".runner/pending", ".runner/accepted", ".runner/rejected"]
            .into_iter()
            .filter_map(|folder| fs::read_dir(directory.join(folder)).ok())
            .flatten()
            .filter_map(Result::ok)
            .filter_map(|entry| entry.path().file_stem()?.to_str()?.parse::<u64>().ok())
            .max()
            .unwrap_or(0);
        Ok(Some((Self { directory, sequence, writer: Some(writer) }, log)))
    }

    pub(crate) fn is_live(directory: &Path) -> bool {
        let live = || -> Option<bool> {
            let status: serde_json::Value =
                serde_json::from_slice(&fs::read(directory.join(".runner/status")).ok()?).ok()?;
            if !matches!(status["state"].as_str(), Some("starting" | "ready")) {
                return Some(false);
            }
            let pid: u32 =
                serde_json::from_slice(&fs::read(directory.join(".runner/pid")).ok()?).ok()?;
            #[cfg(unix)]
            return Some(crate::sys::process_exists(pid));
            #[cfg(not(unix))]
            {
                let _ = pid;
                Some(false)
            }
        };
        live().unwrap_or(false)
    }

    pub(crate) fn publish(&mut self, spec: &Path) -> io::Result<()> {
        let text = fs::read_to_string(spec)?;
        if text.trim().is_empty() {
            return Err(io::Error::other("The spec is empty"));
        }
        let message = serde_json::to_vec(&serde_json::json!({ "text": text }))?;
        if message.len() > 8 * 1024 * 1024 {
            return Err(io::Error::other("The spec update exceeds 8 MiB"));
        }
        self.sequence += 1;
        let destination = self.directory.join(format!("{:020}.json", self.sequence));
        let temporary = destination.with_extension("tmp");
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options.open(&temporary)?;
        file.write_all(&message)?;
        file.sync_all()?;
        // The runner only sees complete, immutable snapshots, never a half-written save.
        fs::hard_link(&temporary, destination)?;
        fs::remove_file(temporary)?;
        #[cfg(unix)]
        fs::File::open(&self.directory)?.sync_all()?;
        Ok(())
    }
}

impl Drop for SpecSession {
    fn drop(&mut self) {
        // Release explicitly: a concurrently forked child may briefly inherit the descriptor.
        if let Some(writer) = &self.writer {
            drop(writer.unlock());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restores_matching_file_without_republishing_and_excludes_other_editors() -> io::Result<()> {
        let root = tempfile::tempdir()?;
        let directory = root.path().join("session");
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        builder.mode(0o700);
        builder.create(&directory)?;
        let spec = root.path().join("spec with spaces.md");
        let other = root.path().join("other.md");
        let log = root.path().join("spec.out");
        fs::write(&spec, "first")?;
        fs::write(&other, "unrelated")?;
        fs::write(&log, "previous output")?;
        let writer = SpecSession::lock(&directory)?;
        let mut session =
            SpecSession { directory: directory.clone(), sequence: 0, writer: Some(writer) };
        session.publish(&spec)?;
        session.remember(&spec, &log)?;
        assert_eq!(
            fs::read_dir(&directory)?
                .filter_map(Result::ok)
                .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
                .count(),
            1
        );
        let accepted = directory.join(".runner/accepted");
        fs::create_dir_all(&accepted)?;
        fs::rename(
            directory.join("00000000000000000001.json"),
            accepted.join("00000000000000000001.json"),
        )?;
        assert!(SpecSession::restore_from(root.path(), &spec).is_err());
        drop(session);
        assert!(SpecSession::restore_from(root.path(), &other)?.is_none());
        let (mut restored, restored_log) = SpecSession::restore_from(root.path(), &spec)?
            .ok_or_else(|| io::Error::other("session not restored"))?;
        assert_eq!(restored_log, log);
        assert_eq!(restored.sequence, 1);
        assert!(!directory.join("00000000000000000001.json").exists());
        assert!(!directory.join("00000000000000000002.json").exists());
        fs::write(&spec, "follow-up")?;
        restored.publish(&spec)?;
        let value: serde_json::Value =
            serde_json::from_slice(&fs::read(directory.join("00000000000000000002.json"))?)?;
        assert_eq!(value["text"], "follow-up");
        assert!(!SpecSession::is_live(&directory));
        Ok(())
    }

    #[test]
    fn published_names_are_never_overwritten() -> io::Result<()> {
        let root = tempfile::tempdir()?;
        let spec = root.path().join("spec");
        fs::write(&spec, "new")?;
        let destination = root.path().join("00000000000000000001.json");
        fs::write(&destination, "original")?;
        let mut session =
            SpecSession { directory: root.path().to_path_buf(), sequence: 0, writer: None };
        assert!(session.publish(&spec).is_err());
        assert_eq!(fs::read_to_string(destination)?, "original");
        Ok(())
    }

    #[test]
    fn publishes_immutable_ordered_snapshots() -> io::Result<()> {
        let root = tempfile::tempdir()?;
        let spec = root.path().join("spec");
        let mut session =
            SpecSession { directory: root.path().to_path_buf(), sequence: 0, writer: None };
        fs::write(&spec, "first \"quoted\"\n\\path\t")?;
        session.publish(&spec)?;
        fs::write(&spec, "second")?;
        session.publish(&spec)?;
        for (sequence, expected) in [(1, "first \"quoted\"\n\\path\t"), (2, "second")] {
            let file = root.path().join(format!("{sequence:020}.json"));
            let value: serde_json::Value = serde_json::from_reader(fs::File::open(&file)?)?;
            assert_eq!(value["text"], expected);
            assert!(!file.with_extension("tmp").exists());
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(fs::metadata(file)?.permissions().mode() & 0o777, 0o600);
            }
        }
        drop(session);
        assert!(root.path().join("00000000000000000001.json").exists());
        Ok(())
    }

    #[test]
    fn invalid_updates_are_not_published() -> io::Result<()> {
        let root = tempfile::tempdir()?;
        let spec = root.path().join("spec");
        let mut session =
            SpecSession { directory: root.path().to_path_buf(), sequence: 0, writer: None };
        assert!(session.publish(&spec).is_err());
        fs::write(&spec, " \n")?;
        assert!(session.publish(&spec).is_err());
        fs::write(&spec, vec![b'a'; 8 * 1024 * 1024])?;
        assert!(session.publish(&spec).is_err());
        assert_eq!(session.sequence, 0);
        Ok(())
    }
}

use std::{ffi::OsString, path::PathBuf};
use tokio::process::Command;

#[derive(Clone)]
pub enum Execution {
    Local(PathBuf),
    Ssh {
        destination: String,
        identity: Option<PathBuf>,
        directory: String,
    },
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

impl Execution {
    pub fn parse(
        value: OsString,
        identity: Option<PathBuf>,
        directory: Option<String>,
    ) -> Result<Self, String> {
        if let Some(destination) = value.to_str().and_then(|s| s.strip_prefix("ssh://")) {
            // Accept SSH host aliases and user@host, never options or shell syntax.
            if destination.is_empty()
                || destination.starts_with('-')
                || destination.split('@').count() > 2
                || destination
                    .split('@')
                    .any(|part| part.is_empty() || part.starts_with('-'))
                || !destination
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"._-@".contains(&c))
            {
                return Err(
                    "SPEC_OPENCODE must use ssh://[user@]host (configure ports in ~/.ssh/config)"
                        .into(),
                );
            }
            if let Some(path) = &identity
                && (!path.is_absolute() || !path.is_file())
            {
                return Err("SPEC_SSH_IDENTITY must be an absolute identity file path".into());
            }
            let directory = directory
                .filter(|s| s.starts_with('/') && !s.contains('\0'))
                .ok_or("SPEC_SSH_DIR must be an absolute remote project directory")?;
            return Ok(Self::Ssh {
                destination: destination.into(),
                identity,
                directory,
            });
        }
        let path = PathBuf::from(value);
        if !path.is_absolute() || !path.is_file() {
            return Err(
                "SPEC_OPENCODE must be an absolute executable file path or ssh://[user@]host"
                    .into(),
            );
        }
        Ok(Self::Local(path))
    }

    pub fn command(&self, root: &std::path::Path) -> Command {
        match self {
            Self::Local(path) => {
                let mut command = Command::new(path);
                command
                    .args(["run", "--dir"])
                    .arg(root)
                    .args(["--agent", "build"]);
                command
            }
            Self::Ssh {
                destination,
                identity,
                directory,
            } => {
                let mut command = Command::new("ssh");
                command.args([
                    "-T",
                    "-o",
                    "BatchMode=yes",
                    "-o",
                    "StrictHostKeyChecking=yes",
                    "-o",
                    "ConnectTimeout=10",
                    "-o",
                    "ServerAliveInterval=15",
                    "-o",
                    "ServerAliveCountMax=3",
                    "-o",
                    "ForwardAgent=no",
                    "-o",
                    "ClearAllForwardings=yes",
                ]);
                if let Some(identity) = identity {
                    command
                        .arg("-i")
                        .arg(identity)
                        .args(["-o", "IdentitiesOnly=yes"]);
                }
                command.arg("--").arg(destination).arg(format!(
                    "bash -lc {} spec {}",
                    quote(include_str!("remote-build.sh")),
                    quote(directory),
                ));
                command
            }
        }
    }
}

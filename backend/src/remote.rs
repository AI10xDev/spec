use sha2::{Digest, Sha256};
use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf, process::Stdio, time::Duration};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

#[derive(serde::Serialize)]
pub struct RepositoryStatus {
    pub connected: bool,
    pub dirty: bool,
    pub directory: Option<String>,
    pub model: &'static str,
}

#[derive(Clone)]
pub struct Remote {
    pub binary: PathBuf,
    pub target: String,
    pub directory: String,
    pub key: Option<PathBuf>,
}

impl Remote {
    pub fn from_env() -> Result<Option<Self>, Box<dyn std::error::Error>> {
        if std::env::var_os("SPEC_COMMAND").is_some() {
            return Err("SPEC_COMMAND is no longer supported. Run the web server locally and configure SPEC_SSH_TARGET and SPEC_SSH_WORKSPACE for remote spec build.".into());
        }
        let target = std::env::var("SPEC_SSH_TARGET").ok();
        let directory = std::env::var("SPEC_SSH_WORKSPACE").ok();
        let key = std::env::var_os("SPEC_SSH_KEY").map(PathBuf::from);
        let binary = std::env::var_os("SPEC_SSH_BINARY").map(PathBuf::from);
        if target.is_none() && directory.is_none() && key.is_none() && binary.is_none() {
            return Ok(None);
        }
        let remote = Self {
            binary: binary.unwrap_or_else(|| "/usr/bin/ssh".into()),
            target: target.ok_or("Set SPEC_SSH_TARGET to user@host or a trusted SSH host alias")?,
            directory: directory.ok_or("Set SPEC_SSH_WORKSPACE to an absolute remote directory")?,
            key,
        };
        remote.validate()?;
        Ok(Some(remote))
    }

    pub fn validate(&self) -> Result<(), Box<dyn std::error::Error>> {
        if self.target.is_empty()
            || self.target.starts_with('-')
            || !self
                .target
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_.-@:[]".contains(&c))
        {
            return Err("SPEC_SSH_TARGET must be user@host or an SSH host alias, not shell syntax or options".into());
        }
        if !self.directory.starts_with('/') || self.directory.chars().any(char::is_control) {
            return Err(
                "SPEC_SSH_WORKSPACE must be an absolute remote directory (no ~ expansion)".into(),
            );
        }
        if !self.binary.is_absolute()
            || !self.binary.is_file()
            || fs::metadata(&self.binary)?.permissions().mode() & 0o111 == 0
        {
            return Err("SPEC_SSH_BINARY must be an absolute executable SSH client path".into());
        }
        if let Some(key) = &self.key {
            if !key.is_absolute() {
                return Err("SPEC_SSH_KEY must be an absolute local private-key file path. Use \"$HOME/.ssh/key\" rather than \"~/.ssh/key\", or unset SPEC_SSH_KEY to use SSH config/ssh-agent.".into());
            }
            let metadata = fs::metadata(key).map_err(|error| {
                format!(
                    "Cannot access SPEC_SSH_KEY local file {}: {error}. Set it to an existing key on this computer, or unset SPEC_SSH_KEY to use SSH config/ssh-agent.",
                    key.display()
                )
            })?;
            if !metadata.is_file() {
                return Err(format!(
                    "SPEC_SSH_KEY must be a local private-key file, not a directory or special file: {}",
                    key.display()
                ).into());
            }
            fs::File::open(key).map_err(|error| {
                format!(
                    "Cannot read SPEC_SSH_KEY local file {}: {error}",
                    key.display()
                )
            })?;
        }
        Ok(())
    }

    pub fn identity(&self) -> String {
        format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&(&self.binary, &self.target, &self.directory, &self.key,))
                    .unwrap()
            )
        )
    }

    fn ssh(&self, script: String) -> Command {
        let mut command = Command::new(&self.binary);
        command.args([
            "-T",
            "-o",
            "BatchMode=yes",
            "-o",
            "StdinNull=no",
            "-o",
            "ForkAfterAuthentication=no",
            "-o",
            "SessionType=default",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            "ConnectTimeout=10",
            "-o",
            "ServerAliveInterval=15",
            "-o",
            "ServerAliveCountMax=2",
            "-o",
            "ClearAllForwardings=yes",
            "-o",
            "ForwardAgent=no",
            "-o",
            "ForwardX11=no",
            "-o",
            "PermitLocalCommand=no",
            "-o",
            "ControlMaster=no",
            "-o",
            "ControlPath=none",
            "-o",
            "RemoteCommand=none",
        ]);
        if let Some(key) = &self.key {
            command
                .arg("-i")
                .arg(key)
                .args(["-o", "IdentitiesOnly=yes"]);
        }
        // SSH joins remote arguments as shell code. Quote each operator-controlled
        // value; document content travels only over stdin, never in this command.
        command.arg("--").arg(&self.target).arg(script);
        command
    }

    pub fn command(&self, bytes: usize, id: &str, name: &str) -> Command {
        self.build_command(bytes, id, name, "build")
    }

    pub fn repository_command(&self, bytes: usize, id: &str, name: &str) -> Command {
        self.build_command(bytes, id, name, "repository-save")
    }

    fn build_command(&self, bytes: usize, id: &str, name: &str, mode: &str) -> Command {
        self.ssh(format!(
            "bash -c {} -- {} {} {} {} {} {} {} {}",
            quote(include_str!("remote-build.bash")),
            quote(&self.directory),
            bytes,
            quote(include_str!("remote-alias.bash")),
            quote(include_str!("remote-supervisor.bash")),
            quote(id),
            quote(name),
            quote(mode),
            quote(include_str!("remote-repository.bash")),
        ))
    }

    pub async fn repository_status(&self) -> Result<RepositoryStatus, String> {
        let mut child = self
            .ssh(format!(
                "timeout --kill-after=1s 10s bash --noprofile --norc -c {} -- {}",
                quote(include_str!("remote-repository.bash")),
                quote(&self.directory),
            ))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| e.to_string())?;
        let pid = child.id().unwrap();
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let result = tokio::time::timeout(Duration::from_secs(15), async {
            let mut out = Vec::new();
            let mut err = Vec::new();
            let mut stdout = stdout.take(16385);
            let mut stderr = stderr.take(4097);
            let (a, b) = tokio::join!(stdout.read_to_end(&mut out), stderr.read_to_end(&mut err));
            a.map_err(|e| e.to_string())?;
            b.map_err(|e| e.to_string())?;
            if out.len() > 16384 || err.len() > 4096 {
                return Err("remote repository response exceeded limit".into());
            }
            let exit = child.wait().await.map_err(|e| e.to_string())?;
            if !exit.success() {
                return Err(format!(
                    "remote repository status {exit}: {}",
                    String::from_utf8_lossy(&err).trim()
                ));
            }
            let text = std::str::from_utf8(&out).map_err(|_| "invalid repository response")?;
            let parts: Vec<_> = text.split('\0').collect();
            if parts.len() != 3 || !parts[2].is_empty() {
                return Err("invalid repository response".into());
            }
            let (connected, dirty) = match parts[0] {
                "SPEC-REPOSITORY-1 0 0" if parts[1].is_empty() => (false, false),
                "SPEC-REPOSITORY-1 1 0" if parts[1].starts_with('/') => (true, false),
                "SPEC-REPOSITORY-1 1 1" if parts[1].starts_with('/') => (true, true),
                _ => return Err("invalid repository response".into()),
            };
            Ok(RepositoryStatus {
                connected,
                dirty,
                directory: connected.then(|| parts[1].to_owned()),
                model: "azure/gpt-6-sol",
            })
        })
        .await
        .unwrap_or_else(|_| Err("remote repository status timed out".to_owned()));
        if result.is_err() {
            let _ = nix::sys::signal::killpg(
                nix::unistd::Pid::from_raw(pid as i32),
                nix::sys::signal::Signal::SIGKILL,
            );
            let _ = child.kill().await;
        }
        result
    }

    pub async fn snapshot(
        &self,
        id: &str,
        cancel: bool,
        name: &str,
    ) -> Result<(String, Vec<u8>, bool), String> {
        let mut child = self
            .ssh(format!(
                "bash -c {} -- {} {} {} {}",
                quote(include_str!("remote-recover.bash")),
                quote(&self.directory),
                quote(id),
                if cancel { "cancel" } else { "snapshot" },
                quote(name),
            ))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| e.to_string())?;
        let pid = child.id().unwrap();
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let result = tokio::time::timeout(Duration::from_secs(15), async {
            let mut out = Vec::new();
            let mut err = Vec::new();
            let mut stdout = stdout.take((super::MAX_OUTPUT + 129) as u64);
            let mut stderr = stderr.take(4097);
            let (a, b) = tokio::join!(stdout.read_to_end(&mut out), stderr.read_to_end(&mut err),);
            a.map_err(|e| e.to_string())?;
            b.map_err(|e| e.to_string())?;
            if out.len() > super::MAX_OUTPUT + 128 || err.len() > 4096 {
                return Err("remote recovery response exceeded limit".into());
            }
            let exit = child.wait().await.map_err(|e| e.to_string())?;
            if !exit.success() {
                return Err(format!(
                    "remote recovery {exit}: {}",
                    String::from_utf8_lossy(&err).trim()
                ));
            }
            let end = out
                .iter()
                .position(|b| *b == b'\n')
                .ok_or("missing recovery header")?;
            let header = std::str::from_utf8(&out[..end]).map_err(|_| "invalid recovery header")?;
            let parts: Vec<_> = header.split(' ').collect();
            if parts.len() != 3 || parts[0] != "SPEC-RUN-1" || !["0", "1"].contains(&parts[2]) {
                return Err("invalid recovery header".into());
            }
            let status = match parts[1] {
                "running" => "running".into(),
                "unknown" => "unknown (remote status unavailable)".into(),
                "0" => "completed".into(),
                "124" => "timed out".into(),
                "130" => "cancelled".into(),
                code => match code.parse::<u8>() {
                    Ok(code) => format!("failed (exit status: {code})"),
                    Err(_) => return Err("invalid remote status".into()),
                },
            };
            let truncated = parts[2] == "1";
            let bytes = out[end + 1..].to_vec();
            if bytes.len() > super::MAX_OUTPUT {
                return Err("remote output exceeded limit".into());
            }
            Ok((status, bytes, truncated))
        })
        .await
        .unwrap_or_else(|_| Err("remote recovery timed out".to_owned()));
        if result.is_err() {
            let _ = nix::sys::signal::killpg(
                nix::unistd::Pid::from_raw(pid as i32),
                nix::sys::signal::Signal::SIGKILL,
            );
            let _ = child.kill().await;
        }
        result
    }
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

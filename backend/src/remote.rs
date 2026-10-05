use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf};
use tokio::process::Command;

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
        if let Some(key) = &self.key
            && (!key.is_absolute() || !key.is_file())
        {
            return Err("SPEC_SSH_KEY must be an absolute local private-key file path".into());
        }
        Ok(())
    }

    pub fn command(&self, bytes: usize) -> Command {
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
        command.arg("--").arg(&self.target).arg(format!(
            "bash -c {} -- {} {} {} {}",
            quote(include_str!("remote-build.bash")),
            quote(&self.directory),
            bytes,
            quote(include_str!("remote-alias.bash")),
            quote(include_str!("remote-supervisor.bash")),
        ));
        command
    }
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

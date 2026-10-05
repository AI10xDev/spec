// SPDX-FileCopyrightText: 2020 Ilaï Deutel & Kibi Contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

//! # sys (UNIX)
//!
//! UNIX-specific structs and functions. Will be imported as `sys` on UNIX
//! systems.
#![expect(unsafe_code)]

use std::io::{self, BufRead};
use std::os::unix::process::CommandExt;
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};

// On UNIX systems, termios represents the terminal mode.
pub use libc::termios as TermMode;
use libc::{SA_SIGINFO, STDIN_FILENO, STDOUT_FILENO, TCSADRAIN, TIOCGWINSZ, VMIN, VTIME};
use libc::{c_int, c_void, sigaction, sighandler_t, siginfo_t, winsize};

use crate::Error;
pub use crate::xdg::*;

fn cerr(err: c_int) -> io::Result<()> {
    if err < 0 { Err(io::Error::last_os_error()) } else { Ok(()) }
}

pub fn user_id() -> u32 {
    unsafe { libc::getuid() }
}

pub fn process_exists(id: u32) -> bool {
    let Ok(id) = c_int::try_from(id) else { return false };
    id > 0 && unsafe { libc::kill(id, 0) } == 0
}

/// Detach jobs from the editor's controlling terminal before executing user code.
pub fn detach_job(command: &mut std::process::Command) {
    unsafe {
        command.pre_exec(|| {
            // A reused Command may already have run this hook.
            if libc::getsid(0) == libc::getpid() {
                return Ok(());
            }
            cerr(libc::setsid())
        });
    }
}

/// Kill a shell job, including descendants still in its dedicated process group.
#[cfg(test)]
pub fn kill_process_group(id: u32) -> io::Result<()> {
    let id = c_int::try_from(id).map_err(io::Error::other)?;
    if id <= 0 {
        return Err(io::Error::other("invalid process group"));
    }
    cerr(unsafe { libc::kill(-id, libc::SIGKILL) })
}

/// Return the current window size as (rows, columns).
///
/// We use the `TIOCGWINSZ` ioctl to get window size. If it succeeds, a
/// `Winsize` struct will be populated.
/// This ioctl is described here: <http://man7.org/linux/man-pages/man4/tty_ioctl.4.html>
pub fn get_window_size() -> Result<(usize, usize), Error> {
    let mut maybe_ws = std::mem::MaybeUninit::<winsize>::uninit();
    cerr(unsafe { libc::ioctl(STDOUT_FILENO, TIOCGWINSZ, maybe_ws.as_mut_ptr()) })
        .map_or(None, |()| unsafe { Some(maybe_ws.assume_init()) })
        .filter(|ws| ws.ws_col != 0 && ws.ws_row != 0)
        .map_or(Err(Error::InvalidWindowSize), |ws| Ok((ws.ws_row as usize, ws.ws_col as usize)))
}

/// Stores whether the window size has changed since last call to
/// `has_window_size_changed`.
static WSC: AtomicBool = AtomicBool::new(false);

/// Handle a change in window size.
extern "C" fn handle_wsize(_: c_int, _: *mut siginfo_t, _: *mut c_void) {
    WSC.store(true, Relaxed);
}

/// Register a signal handler that sets a global variable when the window size
/// changes. After calling this function, use `has_window_size_changed` to query
/// the global variable.
// #[expect(clippy::fn_to_numeric_cast_any)]
pub fn register_winsize_change_signal_handler() -> io::Result<()> {
    unsafe {
        let mut maybe_sa = std::mem::MaybeUninit::<sigaction>::uninit();
        cerr(libc::sigemptyset(&raw mut (*maybe_sa.as_mut_ptr()).sa_mask))?;
        // We could use sa_handler here, however, sigaction defined in libc does not
        // have sa_handler field, so we use sa_sigaction instead.
        (*maybe_sa.as_mut_ptr()).sa_flags = SA_SIGINFO;
        (*maybe_sa.as_mut_ptr()).sa_sigaction = handle_wsize as *const () as sighandler_t;
        cerr(sigaction(libc::SIGWINCH, maybe_sa.as_ptr(), std::ptr::null_mut()))
    }
}

/// Check if the windows size has changed since the last call to this function.
/// The `register_winsize_change_signal_handler` needs to be called before this
/// function.
pub fn has_window_size_changed() -> bool {
    WSC.swap(false, Relaxed)
}

/// Set the terminal mode.
pub fn set_term_mode(term: &TermMode) -> io::Result<()> {
    cerr(unsafe { libc::tcsetattr(STDIN_FILENO, TCSADRAIN, term) })
}

/// Setup the termios to enable raw mode, and return the original termios.
///
/// termios manual is available at: <http://man7.org/linux/man-pages/man3/termios.3.html>
pub fn enable_raw_mode() -> io::Result<TermMode> {
    let mut maybe_term = std::mem::MaybeUninit::<TermMode>::uninit();
    cerr(unsafe { libc::tcgetattr(STDIN_FILENO, maybe_term.as_mut_ptr()) })?;
    let orig_term = unsafe { maybe_term.assume_init() };
    let mut term = orig_term;
    unsafe { libc::cfmakeraw(&raw mut term) };
    // First sets the minimum number of characters for non-canonical reads
    // Second sets the timeout in deciseconds for non-canonical reads
    (term.c_cc[VMIN], term.c_cc[VTIME]) = (0, 1);
    set_term_mode(&term)?;
    Ok(orig_term)
}

/// Construct and lock a new handle to the standard input of the current
/// process.
///
/// # Errors
///
/// This function always returns Ok(...). The return type is a Result for
/// compatibility with other platforms.
pub fn stdin() -> io::Result<impl BufRead> {
    Ok(io::stdin().lock())
}

pub fn path(filename: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(filename)
}

#[cfg(test)]
mod tests {
    use std::{
        fs::File,
        io,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::process::CommandExt,
        },
        process::{Command, Stdio},
        thread,
        time::{Duration, Instant},
    };

    #[test]
    fn escaped_pipe_holder() -> io::Result<()> {
        let Some(pid_file) = std::env::var_os("KIBI_OUTPUT_ESCAPED_PID") else {
            return Ok(());
        };
        let script = if std::env::var_os("KIBI_OUTPUT_BUSY_WRITER").is_some() {
            "while :; do printf '%04096d' 0; done"
        } else {
            "sleep 300"
        };
        let mut command = Command::new("sh");
        command.args(["-c", script]);
        super::detach_job(&mut command);
        let child = command.spawn()?;
        let pid_file = std::path::PathBuf::from(pid_file);
        std::fs::write(pid_file.with_extension("tmp"), child.id().to_string())?;
        std::fs::rename(pid_file.with_extension("tmp"), pid_file)?;
        println!("FINISHED");
        // Intentionally leave the detached descendant holding the captured pipe.
        Ok(())
    }

    #[test]
    fn shell_job_has_no_controlling_tty() -> io::Result<()> {
        if std::env::var_os("KIBI_OUTPUT_PTY_TEST").is_some() {
            let tty = File::open("/dev/tty")?;
            drop(tty);
            let directory = tempfile::tempdir()?;
            let mut output = crate::output::Output::default();
            output.start(Command::new("sh").args([
                "-c",
                "if ( : </dev/tty ) 2>/dev/null; then printf inherited; else printf detached; fi",
            ]), directory.path().join("output.log"))?;
            let deadline = Instant::now() + Duration::from_secs(5);
            while output.is_running() {
                output.poll();
                assert!(Instant::now() < deadline, "detached job did not finish");
                thread::sleep(Duration::from_millis(2));
            }
            assert_eq!(output.lines, ["detached"]);
            return Ok(());
        }

        let (mut master, mut slave) = (-1, -1);
        super::cerr(unsafe {
            libc::openpty(
                &raw mut master,
                &raw mut slave,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        })?;
        let master = unsafe { File::from_raw_fd(master) };
        let slave = unsafe { File::from_raw_fd(slave) };
        for file in [&master, &slave] {
            super::cerr(unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) })?;
        }
        let fd = slave.as_raw_fd();
        let mut command = Command::new(std::env::current_exe()?);
        command
            .args(["--exact", "sys::tests::shell_job_has_no_controlling_tty", "--nocapture"])
            .env("KIBI_OUTPUT_PTY_TEST", "1")
            .stdin(Stdio::null());
        unsafe {
            command.pre_exec(move || {
                super::cerr(libc::setsid())?;
                super::cerr(libc::ioctl(fd, libc::TIOCSCTTY, 0))
            })
        };
        let result = command.output()?;
        drop((master, slave));
        assert!(
            result.status.success(),
            "PTY helper failed: {}{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        Ok(())
    }
}

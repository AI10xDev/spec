// SPDX-FileCopyrightText: 2020 Ilaï Deutel & Kibi Contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

//! # Kibi
//!
//! Kibi is a text editor in ≤1024 lines of code.

pub use crate::{
    config::Config,
    editor::{DEFAULT_SYSTEM_PROMPT, run, run_with_completion_prompt},
    error::Error,
    sys::stdin,
};

pub mod ansi_escape;
mod config;
mod editor;
mod error;
mod filename;
mod markdown;
mod output;
mod row;
mod spec_session;
mod syntax;
mod terminal;

#[cfg_attr(windows, path = "windows.rs")]
#[cfg_attr(unix, path = "unix.rs")]
#[cfg_attr(target_os = "wasi", path = "wasi.rs")]
mod sys;

#[cfg(any(unix, target_os = "wasi"))]
mod xdg;

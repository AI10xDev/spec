// SPDX-FileCopyrightText: 2020 Ilaï Deutel & Kibi Contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

//! # Kibi

use kibi::{DEFAULT_SYSTEM_PROMPT, Error, run, run_with_completion_prompt, stdin};

struct Args {
    file_name: Option<String>,
    system_prompt: Option<String>,
    system_prompt_file: Option<String>,
}

fn too_many_arguments() -> Error {
    Error::TooManyArguments(std::env::args().collect())
}

fn parse_args(args: Vec<String>) -> Result<Args, Error> {
    let mut parsed = Args { file_name: None, system_prompt: None, system_prompt_file: None };
    let mut args = args.into_iter();

    while let Some(arg) = args.next() {
        if parsed.file_name.is_some() && arg != "--" {
            return Err(too_many_arguments());
        }

        match arg.as_str() {
            "--system-prompt" => {
                let system_prompt = args.next().unwrap_or_else(|| DEFAULT_SYSTEM_PROMPT.to_owned());
                parsed.system_prompt = Some(system_prompt);
            }
            "--system-prompt-file" => {
                let Some(system_prompt_file) = args.next() else {
                    return Err(Error::MissingOptionValue(arg));
                };
                parsed.system_prompt_file = Some(system_prompt_file);
            }
            "--" => match (args.next(), args.next()) {
                (None, None) => return Ok(parsed),
                (Some(file_name), None) if parsed.file_name.is_none() => {
                    parsed.file_name = Some(file_name);
                    return Ok(parsed);
                }
                _ => return Err(too_many_arguments()),
            },
            _ if arg.starts_with('-') => return Err(Error::BadOption(arg)),
            _ if parsed.file_name.is_none() => parsed.file_name = Some(arg),
            _ => return Err(too_many_arguments()),
        }
    }

    Ok(parsed)
}

/// Load the configuration, initialize the editor and run the program,
/// optionally opening a file if an argument is given.
///
/// # Errors
///
/// Any error that occur during the execution of the program will be returned by
/// this function.
fn main() -> Result<(), Error> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    match args.as_slice() {
        [] => run(None, &mut stdin()?)?,
        [arg] if arg == "--version" => println!("kibi {}", env!("CARGO_PKG_VERSION")),
        [arg, separator] if arg == "--version" && separator == "--" => {
            println!("kibi {}", env!("CARGO_PKG_VERSION"));
        }
        [arg, ..] if arg == "--version" => return Err(Error::BadOption(arg.clone())),
        _ => {
            let args = parse_args(args)?;
            run_with_completion_prompt(
                args.file_name.as_deref(),
                &mut stdin()?,
                args.system_prompt_file.as_deref(),
                args.system_prompt.as_deref(),
            )?;
        }
    }
    Ok(())
}

use std::collections::HashMap;

pub fn from_env() -> Result<HashMap<String, String>, &'static str> {
    // Read without mutating the environment: the runtime is already multithreaded.
    let file = match std::env::var_os("SPEC_AI_ENV_FILE") {
        Some(path) => {
            dotenvy::from_path_iter(path).map_err(|_| "Could not read SPEC_AI_ENV_FILE")?
        }
        None => match dotenvy::from_filename_iter(".env") {
            Ok(file) => file,
            Err(dotenvy::Error::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(HashMap::new());
            }
            Err(_) => return Err("Could not read AI settings from .env"),
        },
    };
    file.collect::<Result<HashMap<_, _>, _>>()
        // Parser errors can include a source line containing credentials.
        .map_err(|_| "Invalid AI settings file; check dotenv syntax")
}

// Offline test helper: compile against the backend's actual dotenvy dependency.
// Input contains only synthetic fixtures; never print values, even on failure.
use std::io::{self, Read};

fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
    let (expected, dotenv) = input.split_once("\n\n").unwrap();
    let expected: Vec<_> = expected
        .lines()
        .map(|line| line.split_once('=').unwrap())
        .collect();
    let parsed: Result<Vec<_>, _> = dotenvy::from_read_iter(dotenv.as_bytes()).collect();
    let matches = parsed.is_ok_and(|values| {
        values.len() == expected.len()
            && values.iter().zip(expected).all(|((key, value), (k, v))| key == k && value == v)
    });
    if !matches {
        std::process::exit(1);
    }
}

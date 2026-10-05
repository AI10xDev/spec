//! Bounded, local filename discovery. File contents are never opened.
use std::cmp::Reverse;
use std::collections::{BTreeSet, VecDeque};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const MAX_ENTRIES: usize = 50_000;
const SKIP_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".cache",
    "__pycache__",
    ".venv",
    "venv",
];
const MAX_DEPTH: usize = 32;
const MAX_TIME: Duration = Duration::from_secs(2);

#[derive(Default)]
pub struct Search {
    pub path: Option<PathBuf>,
    pub partial: bool,
    pub candidates: Vec<PathBuf>,
    pub priority: usize,
    pub relevant: usize,
    pub notice: String,
}

/// Search below `root`, without following symlinks or escaping to parent directories.
pub fn search(root: &Path, query: &str) -> io::Result<Search> {
    search_bounded(root, query, MAX_ENTRIES)
}

fn search_bounded(root: &Path, query: &str, limit: usize) -> io::Result<Search> {
    let query = query.trim().trim_matches(['`', '"', '\'']).to_lowercase();
    if query.is_empty() {
        return Ok(Search::default());
    }
    let tokens: Vec<_> = query
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .filter(|word| {
            !matches!(*word, "a" | "an" | "the" | "find" | "file" | "for" | "of" | "in" | "please")
        })
        .collect();
    let started = Instant::now();
    let mut queue = VecDeque::from([(root.to_path_buf(), 0)]);
    let mut result = Search::default();
    let mut best = None;
    let mut candidates = BTreeSet::new();
    let mut visited = 0;
    'walk: while let Some((directory, depth)) = queue.pop_front() {
        if started.elapsed() >= MAX_TIME {
            result.partial = true;
            break;
        }
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if depth == 0 => return Err(error),
            Err(_) => {
                result.partial = true;
                continue;
            }
        };
        for entry in entries {
            if visited >= limit || started.elapsed() >= MAX_TIME {
                result.partial = true;
                break 'walk;
            }
            visited += 1;
            let Ok(entry) = entry else {
                result.partial = true;
                continue;
            };
            let Ok(kind) = entry.file_type() else {
                result.partial = true;
                continue;
            };
            if kind.is_dir() {
                if entry.file_name().to_str().is_some_and(|name| SKIP_DIRS.contains(&name)) {
                    continue;
                }
                if depth >= MAX_DEPTH {
                    result.partial = true;
                    continue;
                }
                queue.push_back((entry.path(), depth + 1));
                continue;
            }
            if !kind.is_file() {
                continue;
            }
            let path = entry.path();
            let Ok(relative) = path.strip_prefix(root) else { continue };
            // Do not insert lossy paths or control characters into the spec/terminal.
            let Some(text) = relative
                .to_str()
                .filter(|text| text.len() <= 1024 && !text.chars().any(char::is_control))
            else {
                continue;
            };
            let score = rank(relative, &query, &tokens);
            let key = (Reverse(score), relative.components().count(), text.len(), text.to_owned());
            candidates.insert(key.clone());
            if candidates.len() > 200 {
                candidates.pop_last();
                result.partial = true;
            }
            if score == 0 {
                continue;
            }
            if best.as_ref().is_none_or(|best| key < *best) {
                best = Some(key);
                result.path = Some(relative.to_path_buf());
            }
        }
    }
    result.relevant = candidates.iter().take_while(|key| key.0.0 > 0).count();
    result.priority = candidates.iter().take_while(|key| key.0.0 >= 8_000).count();
    result.candidates = candidates.into_iter().map(|key| PathBuf::from(key.3)).collect();
    Ok(result)
}

/// Keep exact/prefix results first, then ask the configured Azure deployment to rank the rest.
pub fn ranked(root: &Path, query: &str, env_file: Option<&Path>) -> io::Result<Search> {
    let mut result = search(root, query)?;
    if result.candidates.len() > result.priority {
        match semantic_rank(query, &result.candidates[result.priority..], env_file) {
            Ok(indices) => {
                result.candidates = result.candidates[..result.priority]
                    .iter()
                    .cloned()
                    .chain(
                        indices
                            .into_iter()
                            .map(|index| result.candidates[result.priority + index].clone()),
                    )
                    .collect();
                result.notice = "Exact/prefix first; Azure semantic ranking".into();
            }
            Err(error) => {
                result.candidates.truncate(result.relevant);
                result.notice = format!("Local ranking only: {error}");
            }
        }
    } else {
        result.notice = "Exact/prefix matches".into();
    }
    result.candidates.truncate(20);
    result.path = result.candidates.first().cloned();
    Ok(result)
}

fn semantic_rank(
    query: &str, candidates: &[PathBuf], env_file: Option<&Path>,
) -> io::Result<Vec<usize>> {
    let mut command = Command::new("python3");
    command
        .args(["-c", include_str!("../scripts/filename_ranker.py")])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(path) = env_file {
        command.env("KIBI_ENV_FILE", path);
    }
    let mut child = command.spawn()?;
    let payload =
        serde_json::to_vec(&serde_json::json!({"query": query, "candidates": candidates}))?;
    if let Some(mut stdin) = child.stdin.take()
        && let Err(error) = stdin.write_all(&payload)
    {
        let _killed = child.kill();
        let _waited = child.wait();
        return Err(error);
    }
    let output = child.wait_with_output()?;
    if !output.status.success() {
        return Err(io::Error::other("filename ranker failed"));
    }
    decode_ranking(&output.stdout, candidates.len())
}

fn decode_ranking(bytes: &[u8], count: usize) -> io::Result<Vec<usize>> {
    let result: serde_json::Value = serde_json::from_slice(bytes)?;
    if let Some(error) = result["error"].as_str() {
        return Err(io::Error::other(error));
    }
    let indices =
        result["indices"].as_array().ok_or_else(|| io::Error::other("invalid ranking response"))?;
    if indices.len() > 20 {
        return Err(io::Error::other("too many ranking indices"));
    }
    let mut selected = Vec::new();
    for value in indices {
        let index = value
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .filter(|index| *index < count && !selected.contains(index))
            .ok_or_else(|| io::Error::other("invalid ranking index"))?;
        selected.push(index);
    }
    Ok(selected)
}

fn rank(path: &Path, query: &str, tokens: &[&str]) -> usize {
    let text = path.to_string_lossy().replace('\\', "/").to_lowercase();
    let name = path.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
    let stem = path.file_stem().unwrap_or_default().to_string_lossy().to_lowercase();
    if text == query || name == query {
        return 10_000;
    }
    if stem == query {
        return 9_000;
    }
    if name.starts_with(query) {
        return 8_000;
    }
    if name.contains(query) {
        return 7_000;
    }
    if text.contains(query) {
        return 6_000;
    }
    let matched = tokens.iter().filter(|token| text.contains(**token)).count();
    if matched > 0 {
        return 1_000
            + 3_000 * matched / tokens.len()
            + 500 * tokens.iter().filter(|token| name.contains(**token)).count() / tokens.len();
    }
    // Abbreviations such as "authcfg" can match "authentication-config.ts".
    if tokens.len() == 1 && query.chars().count() >= 3 {
        let mut chars = name.chars();
        if query.chars().all(|needle| chars.any(|c| c == needle)) {
            return 500;
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranking_response_must_select_real_distinct_candidates() -> io::Result<()> {
        assert_eq!(decode_ranking(br#"{"indices":[2,0]}"#, 3)?, vec![2, 0]);
        assert!(decode_ranking(br#"{"indices":[]}"#, 3)?.is_empty());
        for json in [
            r#"{"indices":[3]}"#,
            r#"{"indices":[-1]}"#,
            r#"{"indices":[true]}"#,
            r#"{"indices":[0,0]}"#,
            r#"{"indices":["../../secret"]}"#,
            r#"{"error":"unavailable"}"#,
            "not json",
        ] {
            assert!(decode_ranking(json.as_bytes(), 3).is_err(), "response: {json}");
        }
        Ok(())
    }

    #[test]
    fn exact_and_prefix_ranking_needs_no_provider() -> io::Result<()> {
        let dir = tempfile::tempdir()?;
        for name in ["config.ts", "config-extra.ts", "config"] {
            fs::write(dir.path().join(name), "")?;
        }
        let result = ranked(dir.path(), "config", None)?;
        assert_eq!(
            result.candidates,
            ["config", "config.ts", "config-extra.ts"].map(PathBuf::from)
        );
        assert_eq!(result.notice, "Exact/prefix matches");
        Ok(())
    }

    #[test]
    fn ranks_names_paths_and_natural_queries() -> io::Result<()> {
        let dir = tempfile::tempdir()?;
        for file in [
            "src/authentication-config.ts",
            "src/auth/config.ts",
            "config.ts",
            "config.test.ts",
            "docs/configuration.md",
            ".env",
        ] {
            let path = dir.path().join(file);
            fs::create_dir_all(path.parent().ok_or_else(|| io::Error::other("missing parent"))?)?;
            fs::write(path, "")?;
        }
        for (query, expected) in [
            ("CONFIG.TS", "config.ts"),
            ("config", "config.ts"),
            ("src/auth/config", "src/auth/config.ts"),
            ("find the authentication config file", "src/authentication-config.ts"),
            ("authcfg", "src/authentication-config.ts"),
            (".env", ".env"),
        ] {
            assert_eq!(
                search(dir.path(), query)?.path,
                Some(PathBuf::from(expected)),
                "query: {query}"
            );
        }
        assert!(search(dir.path(), "zzzzz")?.path.is_none());
        assert!(search(dir.path(), "   ")?.path.is_none());
        Ok(())
    }

    #[test]
    fn skips_generated_dirs_and_breaks_ties_deterministically() -> io::Result<()> {
        let dir = tempfile::tempdir()?;
        for file in [
            "node_modules/wanted",
            ".git/wanted",
            "target/wanted",
            "b/wanted.rs",
            "a/wanted.rs",
            "bad\nname",
        ] {
            let path = dir.path().join(file);
            fs::create_dir_all(path.parent().ok_or_else(|| io::Error::other("missing parent"))?)?;
            fs::write(path, "")?;
        }
        assert_eq!(search(dir.path(), "wanted")?.path, Some(PathBuf::from("a/wanted.rs")));
        assert!(search(dir.path(), "bad")?.path.is_none());
        assert!(search_bounded(dir.path(), "wanted", 1)?.partial);
        assert!(search(&dir.path().join("missing"), "wanted").is_err());
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn never_follows_symlinks() -> io::Result<()> {
        let dir = tempfile::tempdir()?;
        let outside = tempfile::tempdir()?;
        fs::write(outside.path().join("secret.txt"), "")?;
        std::os::unix::fs::symlink(outside.path(), dir.path().join("linked"))?;
        std::os::unix::fs::symlink(
            outside.path().join("secret.txt"),
            dir.path().join("secret.txt"),
        )?;
        std::os::unix::fs::symlink(dir.path(), dir.path().join("cycle"))?;
        let found = search(dir.path(), "secret")?;
        assert!(found.path.is_none());
        assert!(!found.partial);
        Ok(())
    }
}

// SPDX-License-Identifier: MIT OR Apache-2.0

//! Cached filename search; scanning reads directory metadata, never file contents.

use std::{
    fs,
    io,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const MAX_ENTRIES: usize = 50_000;
const MAX_TIME: Duration = Duration::from_secs(1);
const MAX_DEPTH: usize = 64;
const EXCLUDED: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "target",
    ".venv",
    "venv",
    "vendor",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".cache",
    "__pycache__",
];

/// A read-only snapshot. Matches are relative to the root passed to `new`.
#[derive(Debug, PartialEq)]
pub(crate) struct FileSearch {
    pub(crate) query: String,
    pub(crate) matches: Vec<PathBuf>,
    pub(crate) notice: String,
    paths: Vec<PathBuf>,
}

impl FileSearch {
    /// Scan once, rejecting a symlink root and skipping symlinks below it.
    pub(crate) fn new(root: &Path) -> io::Result<Self> {
        Self::scan(root, MAX_ENTRIES, MAX_TIME)
    }

    fn scan(root: &Path, limit: usize, duration: Duration) -> io::Result<Self> {
        let started = Instant::now();
        if !fs::symlink_metadata(root)?.is_dir() {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "Search root must be a directory"));
        }
        let mut stack = vec![(PathBuf::new(), fs::read_dir(root)?)];
        let mut paths = Vec::new();
        let mut visited = 0;
        let mut limited = false;
        let mut unreadable = false;
        // Iterative depth-first traversal bounds both memory and open directory handles.
        // The deadline is cooperative: an individual filesystem call may still block.
        while let Some((directory, entries)) = stack.last_mut() {
            if visited >= limit || started.elapsed() >= duration {
                limited = true;
                break;
            }
            let Some(entry) = entries.next() else {
                stack.pop();
                continue;
            };
            visited += 1;
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    if directory.as_os_str().is_empty() {
                        return Err(error);
                    }
                    unreadable = true;
                    continue;
                }
            };
            let Ok(kind) = entry.file_type() else {
                unreadable = true;
                continue;
            };
            let relative = directory.join(entry.file_name());
            if kind.is_dir() {
                if entry.file_name().to_str().is_some_and(|name| EXCLUDED.contains(&name)) {
                    continue;
                }
                if stack.len() >= MAX_DEPTH {
                    limited = true;
                    continue;
                }
                match fs::read_dir(entry.path()) {
                    Ok(children) => stack.push((relative, children)),
                    Err(_) => unreadable = true,
                }
            } else if kind.is_file() {
                paths.push(relative);
            }
        }
        paths.sort_unstable();
        let mut notice = format!("Search root: {}", root.display());
        if limited {
            notice.push_str("; incomplete scan (entry, time, or depth limit reached)");
        }
        if unreadable {
            notice.push_str("; incomplete scan (unreadable entries or directories)");
        }
        Ok(Self { query: String::new(), matches: Vec::new(), notice, paths })
    }

    /// Rank the cached snapshot, keeping at most five paths. No filesystem access occurs here.
    pub(crate) fn update(&mut self, query: String) {
        self.query = query;
        self.matches.clear();
        let query = self.query.trim().replace('\\', "/").to_lowercase();
        if query.is_empty() {
            return;
        }
        let tokens: Vec<_> =
            query.split(|c: char| !c.is_alphanumeric()).filter(|token| !token.is_empty()).collect();
        let mut ranked: Vec<_> = self
            .paths
            .iter()
            .filter_map(|path| {
                rank(path, &query, &tokens).map(|score| (score, path.components().count(), path))
            })
            .collect();
        // Prefer shallower paths, then native path order, for otherwise equal scores.
        ranked.sort_unstable();
        self.matches = ranked.into_iter().take(5).map(|(_, _, path)| path.clone()).collect();
    }
}

fn rank(path: &Path, query: &str, tokens: &[&str]) -> Option<(u8, usize)> {
    let name = path.file_name()?.to_string_lossy().to_lowercase();
    if name == query {
        return Some((0, 0));
    }
    if path.file_stem()?.to_string_lossy().to_lowercase() == query {
        return Some((1, 0));
    }
    if name.starts_with(query) {
        return Some((2, 0));
    }
    if name.contains(query) {
        return Some((3, 0));
    }
    let text = path.to_string_lossy().replace('\\', "/").to_lowercase();
    if text.contains(query) {
        return Some((4, 0));
    }
    // Require every term, so directory qualifiers narrow rather than broaden a search.
    if !tokens.is_empty() && tokens.iter().all(|token| text.contains(*token)) {
        return Some((4, tokens.iter().filter(|token| !name.contains(**token)).count()));
    }
    if tokens.len() == 1 && query.chars().count() >= 3 {
        let mut chars = name.chars();
        if query.chars().all(|needle| chars.any(|c| c == needle)) {
            return Some((5, 0));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use std::{fs, io, path::PathBuf, time::Duration};

    use super::{EXCLUDED, FileSearch, MAX_ENTRIES, MAX_TIME};

    fn fixture(files: &[&str]) -> io::Result<tempfile::TempDir> {
        let directory = tempfile::tempdir()?;
        for file in files {
            let path = directory.path().join(file);
            fs::create_dir_all(path.parent().expect("Fixture file has a parent"))?;
            fs::write(path, [])?;
        }
        Ok(directory)
    }

    #[test]
    fn nested_matches_use_a_cached_relative_snapshot() -> io::Result<()> {
        let directory = fixture(&["src/deep/Example.rs"])?;
        let mut search = FileSearch::new(directory.path())?;
        assert!(search.query.is_empty(), "New search has no query");
        assert!(search.matches.is_empty(), "New search has no matches");
        assert!(search.notice.contains(&directory.path().display().to_string()), "Root is visible");
        fs::remove_file(directory.path().join("src/deep/Example.rs"))?;
        fs::write(directory.path().join("Example.rs"), [])?;
        search.update("EXAMPLE".to_owned());
        assert_eq!(search.query, "EXAMPLE");
        assert_eq!(search.matches, [PathBuf::from("src/deep/Example.rs")]);
        Ok(())
    }

    #[test]
    fn relevance_and_top_five() -> io::Result<()> {
        let directory = fixture(&[
            "cfg",
            "cfg.rs",
            "cfg_extra.rs",
            "my_cfg.rs",
            "cfg-folder/other.rs",
            "configuration.rs",
        ])?;
        let mut search = FileSearch::new(directory.path())?;
        search.update("cfg".to_owned());
        assert_eq!(
            search.matches,
            ["cfg", "cfg.rs", "cfg_extra.rs", "my_cfg.rs", "cfg-folder/other.rs"].map(PathBuf::from)
        );
        search.update("cfig".to_owned());
        assert_eq!(search.matches, [PathBuf::from("configuration.rs")]);
        Ok(())
    }

    #[test]
    fn ties_prefer_depth_then_path_order() -> io::Result<()> {
        let directory = fixture(&["b/item.rs", "a/deep/item.rs", "a/item.rs", "item.rs"])?;
        let mut search = FileSearch::new(directory.path())?;
        search.update("item.rs".to_owned());
        assert_eq!(
            search.matches,
            ["item.rs", "a/item.rs", "b/item.rs", "a/deep/item.rs"].map(PathBuf::from)
        );
        Ok(())
    }

    #[test]
    fn spaced_queries_and_directory_terms() -> io::Result<()> {
        let directory = fixture(&[
            "src/auth/login-form.rs",
            "tests/auth/login-form.rs",
            "src/auth/logout.rs",
            "docs/design notes.md",
        ])?;
        let mut search = FileSearch::new(directory.path())?;
        for query in ["SRC auth LOGIN", "src/auth/login", "src\\auth\\login"] {
            search.update(query.to_owned());
            assert_eq!(search.matches, [PathBuf::from("src/auth/login-form.rs")]);
        }
        search.update("design notes".to_owned());
        assert_eq!(search.matches, [PathBuf::from("docs/design notes.md")]);
        Ok(())
    }

    #[test]
    fn excluded_directories_are_skipped_at_any_depth() -> io::Result<()> {
        let directory = fixture(&["src/keep.rs", ".hidden/keep.rs", "src/vendor"])?;
        for name in EXCLUDED {
            for parent in [directory.path().to_path_buf(), directory.path().join("nested")] {
                fs::create_dir_all(parent.join(name))?;
                fs::write(parent.join(name).join("keep.rs"), [])?;
            }
        }
        let mut search = FileSearch::new(directory.path())?;
        search.update("keep".to_owned());
        assert_eq!(search.matches, [".hidden/keep.rs", "src/keep.rs"].map(PathBuf::from));
        search.update("vendor".to_owned());
        assert_eq!(search.matches, [PathBuf::from("src/vendor")]);
        assert!(!search.notice.contains("incomplete"), "Intentional exclusions are not scan failures");
        Ok(())
    }

    #[test]
    fn empty_and_unmatched_queries_clear_results() -> io::Result<()> {
        let directory = fixture(&["hello.rs"])?;
        let mut search = FileSearch::new(directory.path())?;
        for query in ["", " \t ", "zzzzzz"] {
            search.update("hello".to_owned());
            assert_eq!(search.matches.len(), 1);
            search.update(query.to_owned());
            assert!(search.matches.is_empty(), "Empty or unmatched query must clear prior matches");
        }
        Ok(())
    }

    #[test]
    fn scan_limits_are_visible_and_root_failures_are_errors() -> io::Result<()> {
        let directory = fixture(&["hello.rs"])?;
        for (limit, duration) in [(0, MAX_TIME), (MAX_ENTRIES, Duration::ZERO)] {
            let search = FileSearch::scan(directory.path(), limit, duration)?;
            assert!(search.notice.contains("incomplete"), "Scan limits must be visible");
        }
        assert_eq!(
            FileSearch::new(&directory.path().join("missing")).unwrap_err().kind(),
            io::ErrorKind::NotFound
        );
        assert_eq!(
            FileSearch::new(&directory.path().join("hello.rs")).unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_not_followed() -> io::Result<()> {
        use std::os::unix::fs::symlink;

        let directory = fixture(&["keep.rs"])?;
        let outside = fixture(&["secret.rs"])?;
        symlink(outside.path(), directory.path().join("linked"))?;
        symlink(outside.path().join("secret.rs"), directory.path().join("secret.rs"))?;
        symlink(directory.path(), directory.path().join("cycle"))?;
        symlink(directory.path().join("missing"), directory.path().join("broken"))?;
        let mut search = FileSearch::new(directory.path())?;
        search.update("secret".to_owned());
        assert!(search.matches.is_empty(), "Neither directory nor file symlinks should match");
        assert_eq!(search.paths, [PathBuf::from("keep.rs")]);
        assert!(!search.notice.contains("incomplete"), "Symlinks should be skipped without warnings");
        assert_eq!(
            FileSearch::new(&directory.path().join("linked")).unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_subtrees_do_not_discard_readable_matches() -> io::Result<()> {
        use std::os::unix::fs::PermissionsExt;

        let directory = fixture(&["keep.rs", "private/secret.rs"])?;
        let private = directory.path().join("private");
        let permissions = fs::metadata(&private)?.permissions();
        fs::set_permissions(&private, fs::Permissions::from_mode(0))?;
        // Privileged users can still read mode-000 directories.
        let inaccessible = fs::read_dir(&private).is_err();
        let result = FileSearch::new(directory.path());
        fs::set_permissions(&private, permissions)?;
        let mut search = result?;
        if inaccessible {
            assert!(search.notice.contains("unreadable"), "Unreadable subtrees must be reported");
            assert_eq!(search.paths, [PathBuf::from("keep.rs")]);
        }
        search.update("keep".to_owned());
        assert_eq!(search.matches, [PathBuf::from("keep.rs")]);
        Ok(())
    }
}

// SPDX-License-Identifier: MIT OR Apache-2.0

use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use crate::ansi_escape::RESET;

const HEADING: &str = "\x1b[1;36m";
const EMPHASIS: &str = "\x1b[1;35m";
const CODE: &str = "\x1b[33m";
const LINK: &str = "\x1b[34m";
const MARKER: &str = "\x1b[32m";

/// Lightweight, source-preserving Markdown highlighting for streamed output.
#[derive(Clone, Copy, Default)]
pub struct Markdown {
    fence: Option<(u8, usize)>,
}

impl Markdown {
    /// Advance block state even for lines outside the visible scrollback.
    pub(crate) fn advance(&mut self, text: &str) -> bool {
        let trimmed = text.trim_start_matches(' ');
        let marker = trimmed.as_bytes().first().copied().unwrap_or_default();
        let count = trimmed.bytes().take_while(|byte| *byte == marker).count();
        let fenced = self.fence.is_some();
        if text.len() - trimmed.len() <= 3 && matches!(marker, b'`' | b'~') && count >= 3 {
            if let Some((opening, size)) = self.fence {
                if marker == opening && count >= size && trimmed[count..].trim().is_empty() {
                    self.fence = None;
                }
            } else if marker != b'`' || !trimmed[count..].contains('`') {
                self.fence = Some((marker, count));
            }
        }
        fenced || self.fence.is_some()
    }

    /// Emit only our own colour sequences, clipping complete graphemes to the pane.
    pub(crate) fn draw(&mut self, buffer: &mut String, text: &str, width: usize) -> usize {
        let fenced = self.advance(text);
        let mut colors = vec![""; text.len()];
        let trimmed = text.trim_start();
        let indent = text.len() - trimmed.len();
        let hashes = trimmed.bytes().take_while(|byte| *byte == b'#').count();
        if fenced || text.starts_with("    ") {
            colors.fill(CODE);
        } else {
            if indent <= 3
                && (1..=6).contains(&hashes)
                && (hashes == trimmed.len() || trimmed[hashes..].starts_with(' '))
            {
                colors.fill(HEADING);
            } else if trimmed.starts_with('>') {
                colors.fill(MARKER);
            } else {
                let digits = trimmed.bytes().take_while(u8::is_ascii_digit).count();
                let marker = if ["- ", "* ", "+ "].iter().any(|prefix| trimmed.starts_with(prefix))
                {
                    1
                } else if (1..=9).contains(&digits)
                    && (trimmed[digits..].starts_with(". ") || trimmed[digits..].starts_with(") "))
                {
                    digits + 1
                } else {
                    0
                };
                colors[indent..indent + marker].fill(MARKER);
            }
            let mut byte = 0;
            while byte < text.len() {
                let rest = &text[byte..];
                if let Some(escaped) = rest.strip_prefix('\\') {
                    byte += 1 + escaped.chars().next().map_or(0, char::len_utf8);
                    continue;
                }
                let delimiter = if rest.starts_with('`') {
                    &rest[..rest.bytes().take_while(|byte| *byte == b'`').count()]
                } else if rest.starts_with("**") || rest.starts_with("__") {
                    &rest[..2]
                } else if rest.starts_with('*') || rest.starts_with('_') {
                    &rest[..1]
                } else {
                    ""
                };
                if !delimiter.is_empty()
                    && let Some(end) = rest[delimiter.len()..].find(delimiter)
                    && end > 0
                    && (delimiter.starts_with('`')
                        || (!rest[delimiter.len()..].starts_with(char::is_whitespace)
                            && (byte == 0 || !text[..byte].ends_with(char::is_alphanumeric))))
                {
                    let end = byte + delimiter.len() * 2 + end;
                    colors[byte..end].fill(if delimiter.starts_with('`') {
                        CODE
                    } else {
                        EMPHASIS
                    });
                    byte = end;
                    continue;
                }
                if rest.starts_with('[')
                    && let Some(label) = rest.find("](")
                    && let Some(end) = rest[label + 2..].find(')')
                {
                    let end = byte + label + 3 + end;
                    colors[byte..end].fill(LINK);
                    byte = end;
                    continue;
                }
                byte += rest.chars().next().map_or(1, char::len_utf8);
            }
        }

        let mut used = 0;
        let mut current = "";
        for (byte, grapheme) in text.grapheme_indices(true) {
            if grapheme.chars().any(char::is_control) {
                continue;
            }
            let columns = grapheme.width();
            if used + columns > width {
                break;
            }
            if colors[byte] != current {
                buffer.push_str(RESET);
                buffer.push_str(colors[byte]);
                current = colors[byte];
            }
            buffer.push_str(grapheme);
            used += columns;
        }
        if !current.is_empty() {
            buffer.push_str(RESET);
        }
        used
    }
}

#[cfg(test)]
mod tests {
    use super::{CODE, EMPHASIS, HEADING, LINK, MARKER, Markdown, RESET};

    #[test]
    fn highlights_markdown_without_hiding_source() {
        for (text, color, span) in [
            ("## Result", HEADING, "## Result"),
            ("a **bold** result", EMPHASIS, "**bold**"),
            ("an *italic* result", EMPHASIS, "*italic*"),
            ("use `command` here", CODE, "`command`"),
            ("use ``a ` b`` here", CODE, "``a ` b``"),
            ("[docs](https://example.com)", LINK, "[docs](https://example.com)"),
            ("- item", MARKER, "-"),
            ("12. item", MARKER, "12."),
            ("> quote", MARKER, "> quote"),
        ] {
            let mut rendered = String::new();
            Markdown::default().draw(&mut rendered, text, 100);
            assert!(rendered.contains(&format!("{color}{span}{RESET}")), "{rendered:?}");
            assert_eq!(rendered.replace(color, "").replace(RESET, ""), text);
        }
    }

    #[test]
    fn distinguishes_list_markers_from_emphasis() {
        let mut rendered = String::new();
        Markdown::default().draw(&mut rendered, "* **bold**", 100);
        assert_eq!(rendered, format!("{RESET}{MARKER}*{RESET} {RESET}{EMPHASIS}**bold**{RESET}"));
    }

    #[test]
    fn fences_match_marker_length_and_ignore_markdown_inside() {
        let mut markdown = Markdown::default();
        for line in ["````rust", "# not a heading", "```", "~~~", "```` trailing", "````"] {
            let mut rendered = String::new();
            markdown.draw(&mut rendered, line, 100);
            assert_eq!(rendered, format!("{RESET}{CODE}{line}{RESET}"));
        }
        assert!(!markdown.advance("plain"));
        assert!(markdown.advance("  ~~~sh"));
        assert!(markdown.advance("~~~"));
        assert!(!markdown.advance("plain"));
        assert!(!markdown.advance("```not`a fence"));
    }

    #[test]
    fn clips_colors_without_splitting_graphemes_or_leaking_style() {
        let mut rendered = String::new();
        let used =
            Markdown::default().draw(&mut rendered, "**\u{1f469}\u{200d}\u{1f4bb}e\u{301}**", 5);
        assert_eq!(used, 5);
        assert_eq!(
            rendered,
            format!("{RESET}{EMPHASIS}**\u{1f469}\u{200d}\u{1f4bb}e\u{301}{RESET}")
        );
        rendered.clear();
        assert_eq!(Markdown::default().draw(&mut rendered, "# heading", 0), 0);
        assert!(rendered.is_empty());
    }

    #[test]
    fn leaves_plain_output_and_unmatched_delimiters_alone() {
        for text in [
            "plain output",
            "snake_case_name",
            "#hashtag",
            "**partial",
            "\\*literal*",
            "[partial](url",
        ] {
            let mut rendered = String::new();
            Markdown::default().draw(&mut rendered, text, 100);
            assert_eq!(rendered, text);
        }
    }
}

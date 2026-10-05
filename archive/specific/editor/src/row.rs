// SPDX-FileCopyrightText: 2020 Ilaï Deutel & Kibi Contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

//! # Row
//!
//! Utilities for rows. A `Row` owns the underlying characters, the rendered
//! string and the syntax highlighting information.

use std::{iter::repeat_n, num::NonZeroUsize};

use unicode_width::UnicodeWidthChar;

use crate::ansi_escape::{RESET, WBG, push_colored};
use crate::syntax::{Conf as SyntaxConf, HlType};

/// The "Highlight State" of the row
#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub enum HlState {
    /// Normal state.
    #[default]
    Normal,
    /// A multi-line comment has been open, but not yet closed.
    MultiLineComment,
    /// A string has been open with the given quote character (for instance
    /// b'\'' or b'"'), but not yet closed.
    String(u8),
    /// A multi-line string has been open, but not yet closed.
    MultiLineString,
}

/// Represents a row of characters and how it is rendered.
#[derive(Default)]
pub struct Row {
    /// The characters of the row.
    pub chars: Vec<u8>,
    /// How the characters are rendered. In particular, tabs are converted into
    /// several spaces, and bytes may be combined into single UTF-8
    /// characters.
    render: String,
    /// Mapping from indices in `self.chars` to the corresponding indices in
    /// `self.render`.
    pub cx2rx: Vec<usize>,
    /// Mapping from indices in `self.render` to the corresponding indices in
    /// `self.chars`.
    pub rx2cx: Vec<usize>,
    /// The vector of `HLType` for each rendered character.
    pub hl: Vec<HlType>,
    /// The final state of the row.
    pub hl_state: HlState,
    /// If not `None`, the range that is currently matched during a FIND
    /// operation.
    pub match_segment: Option<std::ops::Range<usize>>,
}

impl Row {
    /// Create a new row, containing characters `chars`.
    pub fn new(chars: Vec<u8>) -> Self {
        Self { chars, cx2rx: vec![0], ..Self::default() }
    }

    // TODO: Combine update and update_syntax
    /// Update the row: convert tabs into spaces and compute highlight symbols
    /// The `hl_state` argument is the `HLState` for the previous row.
    pub fn update(&mut self, syntax: &SyntaxConf, hl_state: HlState, tab: NonZeroUsize) -> HlState {
        let (..) = (self.render.clear(), self.cx2rx.clear(), self.rx2cx.clear());
        let (mut cx, mut rx) = (0, 0);
        for c in String::from_utf8_lossy(&self.chars).chars() {
            // The number of rendered characters
            let n_rend_chars =
                if c == '\t' { tab.get() - (rx % tab) } else { c.width().unwrap_or(1) };
            self.render.push_str(&(if c == '\t' { " ".repeat(n_rend_chars) } else { c.into() }));
            self.cx2rx.extend(repeat_n(rx, c.len_utf8()));
            self.rx2cx.extend(repeat_n(cx, n_rend_chars));
            (rx, cx) = (rx + n_rend_chars, cx + c.len_utf8());
        }
        let (..) = (self.cx2rx.push(rx), self.rx2cx.push(cx));
        self.update_syntax(syntax, hl_state)
    }

    /// Obtain the character size, in bytes, given its position in
    /// `self.render`. This is done in constant time by using the difference
    /// between `self.rx2cx[rx]` and the cx for the next character.
    pub fn get_char_size(&self, rx: usize) -> usize {
        self.rx2cx.iter().skip(rx + 1).map(|cx| cx - self.rx2cx[rx]).find(|d| *d > 0).unwrap_or(1)
    }

    /// Update the syntax highlighting types of the row.
    fn update_syntax(&mut self, syntax: &SyntaxConf, mut hl_state: HlState) -> HlState {
        self.hl.clear();
        let line = self.render.as_bytes();

        // Delimiters for multi-line comments and multi-line strings, as Option<&String,
        // &String>
        let ml_comment_delims = syntax.ml_comment_delims.as_ref().map(|(start, end)| (start, end));
        let ml_string_delims = syntax.ml_string_delim.as_ref().map(|x| (x, x));

        'syntax_loop: while self.hl.len() < line.len() {
            let i = self.hl.len();
            let find_str = |s: &str| line.get(i..(i + s.len())).is_some_and(|r| r.eq(s.as_bytes()));

            if hl_state == HlState::Normal && syntax.sl_comment_start.iter().any(|s| find_str(s)) {
                self.hl.extend(repeat_n(HlType::Comment, line.len() - i));
                continue;
            }

            // Multi-line strings and multi-line comments have the same behavior; the only
            // differences are: the start/end delimiters, the `HLState`, the `HLType`.
            for (delims, mstate, mtype) in &[
                (ml_comment_delims, HlState::MultiLineComment, HlType::MlComment),
                (ml_string_delims, HlState::MultiLineString, HlType::MlString),
            ] {
                if let Some((start, end)) = delims {
                    if hl_state == *mstate {
                        if find_str(end) {
                            // Highlight the remaining symbols of the multi line comment end
                            self.hl.extend(repeat_n(mtype, end.len()));
                            hl_state = HlState::Normal;
                        } else {
                            self.hl.push(*mtype);
                        }
                        continue 'syntax_loop;
                    } else if hl_state == HlState::Normal && find_str(start) {
                        // Highlight the remaining symbols of the multi line comment start
                        self.hl.extend(repeat_n(mtype, start.len()));
                        hl_state = *mstate;
                        continue 'syntax_loop;
                    }
                }
            }

            let c = line[i];

            // At this point, hl_state is Normal or String
            if let HlState::String(quote) = hl_state {
                self.hl.push(HlType::String);
                if c == quote {
                    hl_state = HlState::Normal;
                } else if c == b'\\' && i != line.len() - 1 {
                    self.hl.push(HlType::String);
                }
                continue;
            } else if syntax.sl_string_quotes.contains(&(c as char)) {
                hl_state = HlState::String(c);
                self.hl.push(HlType::String);
                continue;
            }

            let prev_sep = (i == 0) || is_sep(line[i - 1]);

            if syntax.highlight_numbers
                && ((c.is_ascii_digit() && prev_sep)
                    || (i != 0 && self.hl[i - 1] == HlType::Number && !prev_sep && !is_sep(c)))
            {
                self.hl.push(HlType::Number);
                continue;
            }

            if prev_sep {
                // This filters makes sure that names such as "in_comment" are not partially
                // highlighted (even though "in" is a keyword in rust)
                // The argument is the keyword that is matched at `i`.
                let s_filter = |kw: &str| line.get(i + kw.len()).is_none_or(|c| is_sep(*c));
                for (keyword_highlight_type, kws) in &syntax.keywords {
                    for keyword in kws.iter().filter(|kw| find_str(kw) && s_filter(kw)) {
                        self.hl.extend(repeat_n(*keyword_highlight_type, keyword.len()));
                    }
                }
            }

            self.hl.push(HlType::Normal);
        }

        // String state doesn't propagate to the next row
        self.hl_state =
            if matches!(hl_state, HlState::String(_)) { HlState::Normal } else { hl_state };
        self.hl_state
    }

    /// Draw the row into a buffer, with `offset` and `max_len` in terminal columns.
    pub fn draw(&self, offset: usize, max_len: usize, buffer: &mut String, use_color: bool) {
        let mut current_hl_type = HlType::Normal;
        let end = offset.saturating_add(max_len);
        let mut rx = 0;
        let mut visible = false;
        for (byte, c) in self.render.char_indices() {
            let width = if c.is_ascii_control() { 1 } else { c.width().unwrap_or(1) };
            let start = rx;
            rx += width;
            if width == 0 {
                // Keep combining marks only when their base was drawn, even at the right edge.
                if !visible {
                    continue;
                }
            } else {
                visible = false;
                if rx <= offset {
                    continue;
                }
                if start >= end || rx > end {
                    break;
                }
                if start < offset {
                    buffer.extend(repeat_n(' ', rx - offset));
                    continue;
                }
                visible = true;
            }
            let mut hl_type = self.hl[byte];
            if c.is_ascii_control() {
                let rendered_char = if (c as u8) <= 26 { (b'@' + c as u8) as char } else { '?' };
                push_colored(buffer, WBG, &rendered_char.to_string(), use_color);
                // Restore previous color
                if use_color && current_hl_type != HlType::Normal {
                    buffer.push_str(&current_hl_type.to_string());
                }
            } else {
                if let Some(match_segment) = &self.match_segment {
                    if match_segment.contains(&start) {
                        // Set the highlight type to Match, i.e. set the background to cyan
                        hl_type = HlType::Match;
                    } else if use_color && current_hl_type == HlType::Match {
                        // Reset the formatting, in particular the background
                        buffer.push_str(RESET);
                    }
                }
                if use_color && current_hl_type != hl_type {
                    buffer.push_str(&hl_type.to_string());
                }
                current_hl_type = hl_type;
                buffer.push(c);
            }
        }
        buffer.push_str(if use_color { RESET } else { "" });
    }
}

/// Return whether `c` is an ASCII separator.
const fn is_sep(c: u8) -> bool {
    c.is_ascii_whitespace() || c == b'\0' || (c.is_ascii_punctuation() && c != b'_')
}

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use super::{HlState, HlType, NonZeroUsize, RESET, Row, SyntaxConf};

    #[rstest]
    #[case::wide_fits("a\u{754c}b", 0, 3, "a\u{754c}")]
    #[case::wide_does_not_fit("a\u{754c}b", 0, 2, "a")]
    #[case::wide_offset("a\u{754c}b", 1, 3, "\u{754c}b")]
    #[case::partial_wide_offset("a\u{754c}b", 2, 2, " b")]
    #[case::partial_wide_only("\u{754c}b", 1, 1, " ")]
    #[case::after_wide("\u{754c}bc", 2, 1, "b")]
    #[case::tabs("\u{754c}\tb", 0, 4, "\u{754c}  ")]
    #[case::tab_offset("\u{754c}\tb", 3, 2, " b")]
    #[case::combining_at_edge("e\u{301}\u{302}b", 0, 1, "e\u{301}\u{302}")]
    #[case::combining_offset("e\u{301}b", 1, 1, "b")]
    #[case::clipped_base("\u{754c}\u{301}b", 1, 2, " b")]
    #[case::leading_combining("\u{301}b", 0, 1, "b")]
    #[case::empty_width("e\u{301}", 0, 0, "")]
    #[case::past_end("\u{754c}", 3, 2, "")]
    #[case::control_width("\0b", 0, 1, "@")]
    fn column_clipping(
        #[case] text: &str, #[case] offset: usize, #[case] max_len: usize, #[case] expected: &str,
    ) {
        let mut row = Row::new(text.as_bytes().to_vec());
        row.update(&SyntaxConf::default(), HlState::Normal, NonZeroUsize::new(4).unwrap());
        let mut buffer = String::new();
        row.draw(offset, max_len, &mut buffer, false);
        assert_eq!(buffer, expected, "clipping must use terminal columns");
    }

    #[rstest]
    #[case::wide("\u{754c} 12", 3)]
    #[case::combining("e\u{301} 12", 2)]
    #[case::tab("\u{754c}\t12", 4)]
    fn byte_indexed_highlight(#[case] text: &str, #[case] offset: usize) {
        let mut row = Row::new(text.as_bytes().to_vec());
        let syntax = SyntaxConf { highlight_numbers: true, ..SyntaxConf::default() };
        row.update(&syntax, HlState::Normal, NonZeroUsize::new(4).unwrap());
        let mut buffer = String::new();
        row.draw(offset, 2, &mut buffer, true);
        assert_eq!(
            buffer,
            format!("{}12{RESET}", HlType::Number),
            "syntax uses rendered byte indices"
        );
    }

    #[test]
    fn match_preserves_syntax_after_wide_character() {
        let mut row = Row::new("\u{754c} 12".as_bytes().to_vec());
        let syntax = SyntaxConf { highlight_numbers: true, ..SyntaxConf::default() };
        row.update(&syntax, HlState::Normal, NonZeroUsize::new(4).unwrap());
        row.match_segment = Some(3..4);
        let mut buffer = String::new();
        row.draw(2, 3, &mut buffer, true);
        assert_eq!(
            buffer,
            format!(" {}1{RESET}{}2{RESET}", HlType::Match, HlType::Number),
            "matches use terminal columns and restore byte-indexed syntax colors",
        );
    }
}

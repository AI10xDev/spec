#!/usr/bin/env python3
"""Verify Markdown colours through a real shell command and editor terminal."""
from pathlib import Path
import runpy
import sys


editor = runpy.run_path(str(Path(__file__).with_name("editor-pty.py")))["editor"]
binary = Path(sys.argv[1] if len(sys.argv) > 1 else
              Path(__file__).resolve().parents[1] / "editor/target/release/kibi").resolve()

for color in (True, False):
    with editor(binary, "spec", "keep document unchanged", color=color) as terminal:
        terminal.send("\x05printf '# Heading\\n**bold** and `code`\\n[docs](url)\\n- item\\n```sh\\n# code\\n```\\n\\033[2JSAFE\\n'\r")
        terminal.wait("Exited:")
        for text in ("# Heading", "**bold** and `code`", "[docs](url)", "- item", "# code", "SAFE"):
            assert text in terminal.screen, terminal.screen
        for sequence in (b"\x1b[1;36m# Heading", b"\x1b[1;35m**bold**", b"\x1b[33m`code`",
                         b"\x1b[34m[docs](url)", b"\x1b[32m-", b"\x1b[33m# code"):
            assert (sequence in terminal.trace) == color, (color, sequence, terminal.trace)
        assert b"\x1b[2J" not in terminal.trace, "shell control sequence escaped sanitization"
        assert (terminal.root / "spec").read_text() == "keep document unchanged"
        terminal.resize(40)
        assert "Output" in terminal.screen
    print(f"PASS Markdown output with color={color}", flush=True)

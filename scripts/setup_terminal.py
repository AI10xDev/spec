"""Terminal intro and progress for the SPEC setup wizard.

Pass enabled=False to both helpers for --no-animation.
"""

# Adapted from AI10xDev/computeruse, computeruse-setup/setup.py (MIT).
# See COMPUTERUSE-LICENSE for the upstream license.
from contextlib import contextmanager
from itertools import cycle
import os
import shutil
import sys
import threading
import time


@contextmanager
def progress(label, enabled=True):
    """Animate only between prompts, leaving logs and terminal state intact."""
    animated = (
        enabled and sys.stdin.isatty() and sys.stdout.isatty()
        and sys.stderr.isatty() and os.environ.get("TERM") != "dumb"
    )
    stopped = threading.Event()
    worker = None
    width = max(1, min(len(label) + 4, shutil.get_terminal_size().columns - 1))

    def spin():
        for frame in cycle("|/-\\"):
            if stopped.is_set():
                break
            print("\r" + f"[{frame}] {label}"[:width], end="", file=sys.stderr, flush=True)
            if stopped.wait(0.1):
                break

    outcome = "stopped"
    try:
        if animated:
            worker = threading.Thread(target=spin, name="spec-progress", daemon=True)
            worker.start()
        else:
            print(f"[working] {label}", file=sys.stderr, flush=True)
        yield animated
        outcome = "done"
    finally:
        stopped.set()
        if worker is not None:
            # Startup can be interrupted before the thread has actually started.
            if worker.is_alive():
                worker.join()
            print("\r" + " " * width + "\r", end="", file=sys.stderr, flush=True)
        print(f"[{outcome}] {label}", file=sys.stderr, flush=True)


def launch(enabled=True):
    animated = (
        enabled and sys.stdin.isatty() and sys.stdout.isatty()
        and sys.stderr.isatty() and os.environ.get("TERM") != "dumb"
    )
    if not animated:
        print("\n  S P E C\n  Local-first / setup wizard\n", file=sys.stderr)
        return

    colors = "NO_COLOR" not in os.environ
    extended = "256color" in os.environ.get("TERM", "") or os.environ.get("COLORTERM") in ("truecolor", "24bit")
    palette = ("38;5;51", "38;5;45", "38;5;39", "38;5;99", "38;5;141", "38;5;183") if extended else ("96", "94", "95")
    columns = shutil.get_terminal_size().columns
    resized = False

    def draw(text, newline=False, tone=None):
        nonlocal columns, resized
        current_columns = shutil.get_terminal_size().columns
        if current_columns != columns:
            # Reflow is terminal-specific: stop redrawing and finish below old frames.
            old_width = max(1, min(68, columns - 1))
            print("\n" * (old_width // max(1, current_columns) + 1), end="\r", file=sys.stderr)
            columns, resized = current_columns, True
        width = max(1, min(68, columns - 1))
        text = text[:width].ljust(width)
        if colors:
            span = max(1, len(text.rstrip()))
            text = "".join(
                f"\x1b[{tone or palette[min(len(palette) - 1, i * len(palette) // span)]}m{char}"
                for i, char in enumerate(text)
            ) + "\x1b[0m"
        print("\r" + text, end="\n" if newline else "", file=sys.stderr, flush=True)

    complete = False
    try:
        print(file=sys.stderr)
        draw("  " + "-" * 54, newline=True)
        title = "  S P E C"
        for length in range(3, len(title) + 1):
            draw(title[:length] + "_")
            if resized:
                break
            time.sleep(0.025)
        draw(title, newline=True)
        draw("  LOCAL-FIRST / SETUP WIZARD", newline=True, tone="90")
        print(file=sys.stderr)
        for position in range(28):
            if resized:
                break
            bar = "".join(
                ">" if i == position else "=" if position - 4 <= i < position else "."
                for i in range(28)
            )
            draw(f"  [{bar}]  preparing your interview")
            time.sleep(0.025)
        draw("  [ READY ]  Your machine. Your choices.", newline=True, tone="92")
        draw("  REVIEW FIRST. NOTHING INSTALLS AUTOMATICALLY.", newline=True, tone="90")
        draw("  " + "-" * 54, newline=True)
        print(file=sys.stderr)
        complete = True
    finally:
        if colors:
            print("\x1b[0m", end="", file=sys.stderr, flush=True)
        if not complete:
            draw("")
            print("\r", end="", file=sys.stderr)
            print("[stopped] Launch intro", file=sys.stderr, flush=True)

"""Deterministic stdlib tests for the setup terminal helpers."""

from contextlib import nullcontext
import io
import os
import re
import unittest
from unittest.mock import call, patch

import setup_terminal as terminal


class TerminalTests(unittest.TestCase):
    def setUp(self):
        self.stdin, self.stdout, self.stderr = (io.StringIO() for _ in range(3))
        for name in ("stdin", "stdout", "stderr"):
            stream = getattr(self, name)
            self.patch(terminal.sys, name, stream)
            self.patch(stream, "isatty", return_value=True)
        environment = patch.dict(os.environ, {"TERM": "xterm"}, clear=True)
        environment.start()
        self.addCleanup(environment.stop)
        self.size = self.patch(
            terminal.shutil, "get_terminal_size",
            return_value=os.terminal_size((80, 24)),
        )
        self.sleep = self.patch(terminal.time, "sleep")

    def patch(self, target, name, *args, **kwargs):
        patcher = patch.object(target, name, *args, **kwargs)
        result = patcher.start()
        self.addCleanup(patcher.stop)
        return result

    def test_static_intro_and_progress_gates(self):
        cases = ("disabled", "stdin", "stdout", "stderr", "dumb")
        for case in cases:
            with self.subTest(case=case):
                self.stderr.seek(0)
                self.stderr.truncate()
                for name in ("stdin", "stdout", "stderr"):
                    getattr(self, name).isatty.return_value = name != case
                os.environ["TERM"] = "dumb" if case == "dumb" else "xterm"
                enabled = case != "disabled"
                with patch.object(terminal.threading, "Thread") as thread:
                    terminal.launch(enabled=enabled)
                    with terminal.progress("Checking", enabled=enabled) as animated:
                        self.assertFalse(animated)
                    thread.assert_not_called()
                self.assertEqual(
                    self.stderr.getvalue(),
                    "\n  S P E C\n  Local-first / setup wizard\n\n"
                    "[working] Checking\n[done] Checking\n",
                )
                self.assertNotIn("\x1b", self.stderr.getvalue())
                self.assertNotIn("\r", self.stderr.getvalue())
                self.sleep.assert_not_called()
                self.assertEqual(self.stdout.getvalue(), "")

    def test_animated_intro_exact_frames_and_colors(self):
        extended = ("38;5;51", "38;5;45", "38;5;39", "38;5;99", "38;5;141", "38;5;183")
        cases = (
            ({"TERM": "xterm"}, ("96", "94", "95")),
            ({"TERM": "xterm-256color"}, extended),
            ({"TERM": "xterm", "COLORTERM": "truecolor"}, extended),
            ({"TERM": "xterm", "COLORTERM": "24bit"}, extended),
            ({"TERM": "xterm", "NO_COLOR": ""}, None),
            ({"TERM": "xterm-256color", "NO_COLOR": "1"}, None),
        )
        for environment, palette in cases:
            with self.subTest(environment=environment), patch.dict(os.environ, environment, clear=True):
                self.stderr.seek(0)
                self.stderr.truncate()
                self.sleep.reset_mock()
                terminal.launch()
                frames = [("  " + "-" * 54, True, None)]
                title = "  S P E C"
                frames.extend((title[:length] + "_", False, None) for length in range(3, 10))
                frames.extend(((title, True, None), ("  LOCAL-FIRST / SETUP WIZARD", True, "90")))
                # Build the traveling four-character tail independently of the renderer.
                for position in range(28):
                    bar = "." * max(0, position - 4) + "=" * min(position, 4) + ">" + "." * (27 - position)
                    frames.append((f"  [{bar}]  preparing your interview", False, None))
                frames.extend((
                    ("  [ READY ]  Your machine. Your choices.", True, "92"),
                    ("  REVIEW FIRST. NOTHING INSTALLS AUTOMATICALLY.", True, "90"),
                    ("  " + "-" * 54, True, None),
                ))
                expected = "\n"
                for index, (text, newline, tone) in enumerate(frames):
                    padded = text.ljust(68)
                    if palette:
                        padded = "".join(
                            f"\x1b[{tone or palette[min(len(palette) - 1, i * len(palette) // len(text.rstrip()))]}m{char}"
                            for i, char in enumerate(padded)
                        ) + "\x1b[0m"
                    expected += "\r" + padded + ("\n" if newline else "")
                    if index == 9:
                        expected += "\n"
                expected += "\n" + ("\x1b[0m" if palette else "")
                self.assertEqual(self.stderr.getvalue(), expected)
                self.assertEqual(self.sleep.call_args_list, [call(0.025)] * 35)
                self.assertEqual(self.stdout.getvalue(), "")

    def test_narrow_intro_clips_before_coloring(self):
        for columns in (1, 2, 8, 32, 80):
            with self.subTest(columns=columns):
                self.stderr.seek(0)
                self.stderr.truncate()
                self.size.return_value = os.terminal_size((columns, 24))
                terminal.launch()
                plain = re.sub(r"\x1b\[[0-9;]*m", "", self.stderr.getvalue())
                width = max(1, min(68, columns - 1))
                self.assertTrue(all(len(line) == width for line in plain.splitlines() if line))

    def test_resize_stops_motion_during_reveal_or_bar(self):
        for after, columns in ((1, 32), (9, 32), (1, 100)):
            with self.subTest(after=after, columns=columns):
                self.stderr.seek(0)
                self.stderr.truncate()
                self.sleep.reset_mock()
                self.size.return_value = os.terminal_size((80, 24))

                def resize(_):
                    if self.sleep.call_count == after:
                        self.size.return_value = os.terminal_size((columns, 24))

                self.sleep.side_effect = resize
                terminal.launch()
                self.assertEqual(self.sleep.call_count, after if after == 1 else after + 1)
                plain = re.sub(r"\x1b\[[0-9;]*m", "", self.stderr.getvalue())
                self.assertIn("\n" * (68 // columns + 1) + "\r", plain)
                self.assertIn("[ READY ]", plain)
                self.assertNotIn("[stopped]", plain)

    def test_intro_interrupt_clears_line_and_resets_colors(self):
        for no_color in (False, True):
            with self.subTest(no_color=no_color):
                self.stderr.seek(0)
                self.stderr.truncate()
                if no_color:
                    os.environ["NO_COLOR"] = ""
                self.sleep.side_effect = KeyboardInterrupt
                with self.assertRaises(KeyboardInterrupt):
                    terminal.launch()
                output = self.stderr.getvalue()
                self.assertTrue(output.endswith("\r[stopped] Launch intro\n"))
                self.assertNotIn("[ READY ]", output)
                if no_color:
                    self.assertNotIn("\x1b", output)
                    self.assertIn("\r" + " " * 68 + "\r", output)
                else:
                    self.assertTrue(output.endswith("\x1b[0m\r[stopped] Launch intro\n"))

    def test_intro_interrupt_during_partial_ready_write(self):
        original_write = self.stderr.write
        interrupted = False

        def write(text):
            nonlocal interrupted
            if "\x1b[92m" in text and not interrupted:
                interrupted = True
                original_write("\x1b[92m[ RE")
                raise KeyboardInterrupt
            return original_write(text)

        self.patch(self.stderr, "write", side_effect=write)
        with self.assertRaises(KeyboardInterrupt):
            terminal.launch()
        self.assertIn("\x1b[92m[ RE\x1b[0m", self.stderr.getvalue())
        self.assertTrue(self.stderr.getvalue().endswith("\x1b[0m\r[stopped] Launch intro\n"))

    def test_progress_success_failure_and_interrupt(self):
        for animated in (False, True):
            for error in (None, RuntimeError("failed"), KeyboardInterrupt()):
                with self.subTest(animated=animated, error=error):
                    self.stderr.seek(0)
                    self.stderr.truncate()
                    with patch.object(terminal.threading, "Thread") as thread, patch.object(terminal.threading, "Event") as event:
                        stopped = event.return_value
                        stopped.is_set.return_value = False
                        stopped.wait.side_effect = [False, False, False, False, True]
                        worker = thread.return_value
                        worker.start.side_effect = lambda: thread.call_args.kwargs["target"]()
                        worker.is_alive.return_value = True
                        expectation = self.assertRaises(type(error)) if error else nullcontext()
                        with expectation:
                            with terminal.progress("Checking", enabled=animated) as running:
                                self.assertEqual(running, animated)
                                if error:
                                    raise error
                        stopped.set.assert_called_once_with()
                        if animated:
                            self.assertEqual(thread.call_args.kwargs["name"], "spec-progress")
                            self.assertTrue(thread.call_args.kwargs["daemon"])
                            worker.join.assert_called_once_with()
                            self.assertEqual(stopped.wait.call_args_list, [call(0.1)] * 5)
                            prefix = "".join(f"\r[{frame}] Checking" for frame in "|/-\\|") + "\r" + " " * 12 + "\r"
                        else:
                            thread.assert_not_called()
                            prefix = "[working] Checking\n"
                        outcome = "stopped" if error else "done"
                        self.assertEqual(self.stderr.getvalue(), prefix + f"[{outcome}] Checking\n")

    def test_progress_interrupted_thread_start(self):
        for alive in (False, True):
            with self.subTest(alive=alive), patch.object(terminal.threading, "Thread") as thread, patch.object(terminal.threading, "Event") as event:
                self.stderr.seek(0)
                self.stderr.truncate()
                worker = thread.return_value
                worker.start.side_effect = KeyboardInterrupt
                worker.is_alive.return_value = alive
                with self.assertRaises(KeyboardInterrupt):
                    with terminal.progress("Checking"):
                        self.fail("Interrupted startup entered context body")
                event.return_value.set.assert_called_once_with()
                self.assertEqual(worker.join.call_count, int(alive))
                self.assertEqual(self.stderr.getvalue(), "\r" + " " * 12 + "\r[stopped] Checking\n")

    def test_progress_narrow_and_already_stopped(self):
        for columns, stopped_before_frame in ((1, False), (8, False), (80, True)):
            with self.subTest(columns=columns, stopped=stopped_before_frame), patch.object(terminal.threading, "Thread") as thread, patch.object(terminal.threading, "Event") as event:
                self.stderr.seek(0)
                self.stderr.truncate()
                self.size.return_value = os.terminal_size((columns, 24))
                event.return_value.is_set.return_value = stopped_before_frame
                event.return_value.wait.return_value = True
                thread.return_value.start.side_effect = lambda: thread.call_args.kwargs["target"]()
                with terminal.progress("Checking"):
                    pass
                width = max(1, min(12, columns - 1))
                prefix = "" if stopped_before_frame else "\r" + "[|] Checking"[:width]
                self.assertEqual(self.stderr.getvalue(), prefix + "\r" + " " * width + "\r[done] Checking\n")


if __name__ == "__main__":
    unittest.main()

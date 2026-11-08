#!/usr/bin/env python3
"""Offline operator-only marketplace setup (Python 3.9+, POSIX)."""

import argparse
import getpass
import ipaddress
import os
from pathlib import Path
import pwd
import re
import secrets
import signal
import stat
import sys
import warnings
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parent.parent
FIELDS = (
    ("SPEC_SKILLS_GITHUB_TOKEN", "GitHub Contents-read token", ""),
    ("SPEC_SKILLS_GITHUB_REPO", "GitHub owner/repository", ""),
    ("SPEC_SKILLS_GITHUB_REF", "GitHub ref [main]", "main"),
    ("SPEC_PAYPAL_CLIENT_ID", "PayPal app client ID", ""),
    ("SPEC_PAYPAL_CLIENT_SECRET", "PayPal app secret", ""),
    ("SPEC_PAYPAL_MERCHANT_ID", "PayPal business merchant ID (not email)", ""),
    ("SPEC_PAYPAL_RETURN_URL", "HTTPS Spec return URL (no query/fragment)", ""),
    ("SPEC_PAYPAL_MODE", "PayPal mode [sandbox] or live", "sandbox"),
)


def validate(key, value):
    if not value or len(value) > 4096 or not all(33 <= ord(c) <= 126 for c in value):
        raise ValueError("Use nonempty printable ASCII without whitespace; maximum 4096 characters.")
    identifier = lambda text: bool(re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", text)) and text not in (".", "..")
    if key == "SPEC_SKILLS_GITHUB_REPO":
        if len(value.split("/")) != 2 or not all(identifier(part) for part in value.split("/")):
            raise ValueError("Use owner/repository with ASCII letters, digits, dots, underscores or hyphens.")
    elif key == "SPEC_SKILLS_GITHUB_REF":
        if (len(value) > 200 or not re.fullmatch(r"[A-Za-z0-9_./-]+", value)
                or ".." in value or any(part in ("", ".") or part.endswith(".lock")
                                         for part in value.split("/"))
                or value.startswith("-") or value.endswith(".")):
            raise ValueError("Use a branch, tag or commit of at most 200 ASCII letters, digits, _.-/; no traversal.")
    elif key == "SPEC_PAYPAL_MERCHANT_ID":
        if not identifier(value):
            raise ValueError("Use the business merchant ID, not an email; maximum 100 ASCII letters, digits, _.-.")
    elif key == "SPEC_PAYPAL_RETURN_URL":
        error = "Use an HTTPS URL with a valid host/port, no credentials, query, fragment or backslash."
        try:
            url = urlsplit(value)
            host = url.hostname
            url.port
            if (len(value) > 2048 or url.scheme != "https" or not host
                    or url.username is not None or url.password is not None
                    or any(c in value for c in "?#\\")
                    or re.search(r"%(?![0-9A-Fa-f]{2})", value)):
                raise ValueError(error)
            if url.netloc.startswith("["):
                if not re.fullmatch(r"\[[0-9A-Fa-f:.]+\](?::[0-9]+)?", url.netloc):
                    raise ValueError(error)
                ipaddress.IPv6Address(host)
            elif (not re.fullmatch(r"[A-Za-z0-9.-]+(?::[0-9]+)?", url.netloc)
                  or any(not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", label)
                         for label in host.rstrip(".").split("."))):
                raise ValueError(error)
        except ValueError:
            raise ValueError(error) from None
    elif key == "SPEC_PAYPAL_MODE" and value not in ("sandbox", "live"):
        raise ValueError("Mode must be exactly sandbox or live.")
    return value


def serialize(values):
    fields = FIELDS
    if values.get("SPEC_SKILLS_PUBLIC_EXAMPLES") == "1":
        if (values.get("SPEC_PAYPAL_MODE") != "sandbox" or
                values.get("SPEC_SKILLS_GITHUB_REPO", "").lower() != "ai10x/skills-marketplace-examples"):
            raise ValueError("Public examples require sandbox mode and the exact example repository.")
        fields = tuple(field for field in FIELDS if field[0] != "SPEC_SKILLS_GITHUB_TOKEN") + (
            ("SPEC_SKILLS_PUBLIC_EXAMPLES", "", ""),)
    if set(values) != {key for key, _, _ in fields}:
        raise ValueError("All marketplace settings are required; unknown settings are refused.")
    lines = []
    for key, _, _ in fields:
        value = validate(key, values[key])
        # Keep apostrophes AND backslashes outside strong quotes: dotenvy's
        # multiline scanner treats backslashes differently from its value parser.
        # Strong quotes suppress both dotenv substitution and shell expansion.
        quoted = "".join("'\\''" if c == "'" else "'\\\\'" if c == "\\" else c for c in value)
        lines.append(key + "='" + quoted + "'\n")
    return "".join(lines).encode("ascii")


def hidden(prompt):
    if not sys.stdin.isatty() or not sys.stderr.isatty():
        raise ValueError("A private interactive terminal on stdin and stderr is required; piped input is refused.")
    with warnings.catch_warnings():
        warnings.simplefilter("error", getpass.GetPassWarning)
        return getpass.getpass(prompt + " (hidden): ", stream=sys.stderr)


def collect():
    values = {}
    for key, label, default in FIELDS:
        while True:
            try:
                answer = hidden(label)
                values[key] = validate(key, default if answer == "" else answer)
                break
            except ValueError as error:
                # Validators contain only static messages, never operator input.
                print(str(error), file=sys.stderr)
                if not sys.stdin.isatty() or not sys.stderr.isatty():
                    raise
    if values["SPEC_PAYPAL_MODE"] == "live":
        if hidden("Real charges enabled. Type ENABLE LIVE PAYMENTS to confirm") != "ENABLE LIVE PAYMENTS":
            raise ValueError("Live mode not confirmed; nothing saved.")
    if hidden("Save private plaintext credentials? Type SAVE to confirm") != "SAVE":
        raise ValueError("Save not confirmed; nothing saved.")
    return values


def output_path(value, workspace, ui_dir):
    path = Path(value)
    if (path.anchor != "/" or ".." in path.parts or path.name in ("", ".", "..")
            or any(ord(c) < 32 or ord(c) == 127 for c in str(path))):
        raise ValueError("Choose an absolute output file path without traversal or control characters.")
    for public in (ROOT, Path(workspace).resolve(), Path(ui_dir).resolve()):
        if path == public or public in path.parents:
            raise ValueError("Keep credentials outside the repository, editable workspace and static UI tree.")
    return path


def write_private(path, data):
    """Walk pinned directory FDs; publish a complete file atomically without overwrite."""
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    directory = os.open("/", flags)
    temporary = None
    try:
        for index, part in enumerate(path.parts[1:-1]):
            last = index == len(path.parts) - 3
            try:
                child = os.open(part, flags, dir_fd=directory)
            except FileNotFoundError:
                if not last:
                    raise ValueError("Output ancestors must exist; only the private parent may be created.") from None
                os.mkdir(part, 0o700, dir_fd=directory)
                child = os.open(part, flags, dir_fd=directory)
            os.close(directory)
            directory = child
            info = os.fstat(directory)
            mode = stat.S_IMODE(info.st_mode)
            # A root-owned sticky ancestor (e.g. /tmp) cannot replace our owned child.
            sticky_root = info.st_uid == 0 and bool(info.st_mode & stat.S_ISVTX)
            if info.st_uid not in (0, os.geteuid()) or (mode & 0o022 and not sticky_root):
                raise ValueError("Output ancestors must be trusted and not writable by other users.")
            if last and (info.st_uid != os.geteuid() or mode != 0o700):
                raise ValueError("Existing output parent must be owned by you with permissions 0700; no permissions were changed.")
        if len(path.parts) < 3:
            raise ValueError("Choose a private parent directory, not the filesystem root.")
        # lstat only: never read a destination, including a dangling symlink.
        try:
            os.stat(path.name, dir_fd=directory, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise ValueError("Output already exists; choose a new filename. Nothing was overwritten.")
        name = ".marketplace-" + secrets.token_hex(16) + ".tmp"
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                     0o600, dir_fd=directory)
        temporary = name
        with os.fdopen(fd, "wb") as output:
            os.fchmod(output.fileno(), 0o600)
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.link(temporary, path.name, src_dir_fd=directory, dst_dir_fd=directory,
                follow_symlinks=False)
        os.unlink(temporary, dir_fd=directory)
        temporary = None
        os.fsync(directory)
    finally:
        if temporary is not None:
            os.unlink(temporary, dir_fd=directory)
        os.close(directory)


class Parser(argparse.ArgumentParser):
    def error(self, message):
        # argparse's usual error includes unknown arguments, possibly pasted secrets.
        self.exit(2, "Invalid arguments. Use --help; never pass credentials as arguments.\n")


def main(argv=None):
    parser = Parser(description=__doc__)
    parser.add_argument("--output", default=str(Path(pwd.getpwuid(os.getuid()).pw_dir) / ".spec-marketplace/marketplace.env"),
                        help="New absolute private file; default: login-home/.spec-marketplace/marketplace.env")
    parser.add_argument("--workspace", default=os.environ.get("SPEC_WORKSPACE", str(ROOT / "workspace")),
                        help="Actual editable workspace to exclude (default: SPEC_WORKSPACE or repository workspace)")
    parser.add_argument("--ui-dir", default=os.environ.get("SPEC_UI_DIR", str(ROOT / "frontend/dist")),
                        help="Actual static UI directory to exclude (default: SPEC_UI_DIR or frontend/dist)")
    args = parser.parse_args(argv)
    try:
        if not sys.stdin.isatty() or not sys.stderr.isatty():
            raise ValueError("A private interactive terminal on stdin and stderr is required; piped input is refused.")
        path = output_path(args.output, args.workspace, args.ui_dir)
        print("Offline setup: all input is hidden. No network calls or existing credential reads.\n"
              "Use a private, unrecorded terminal. Ctrl+C cancels. Sandbox is the default.\n"
              "Only the final parent may be created; existing files are never overwritten.", file=sys.stderr)
        data = serialize(collect())
        write_private(path, data)
    except (KeyboardInterrupt, EOFError):
        print("Setup cancelled. No partial configuration was published.", file=sys.stderr)
        return 1
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 1
    except (OSError, getpass.GetPassWarning):
        print("Secure terminal or file operation failed. No partial configuration was published.\n"
              "A complete file may exist if final synchronization failed; never overwrite it blindly.", file=sys.stderr)
        return 1
    print("Private configuration saved. Set SPEC_AI_ENV_FILE to the chosen absolute path and restart Spec.\n"
          "This replaces shared AI dotenv discovery, not merges it. Process exports still override file values.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    def cancel(signum, frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, cancel)
    raise SystemExit(main())

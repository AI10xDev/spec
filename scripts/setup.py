#!/usr/bin/env python3
"""Conversational setup for the Spec web app; no model or menu navigation needed."""

import argparse
from contextlib import redirect_stdout
import io
import json
import os
from pathlib import Path
import platform
import re
import shlex
import shutil
import stat
import subprocess
import sys

sys.dont_write_bytecode = True

from setup_ai import collect_ai
from setup_terminal import launch, progress


ROOT = Path(__file__).resolve().parent.parent
USER_TOOLS = {"cargo": ".cargo/bin", "bun": ".bun/bin"}


def ask(label, default="", validate=None):
    while True:
        print("\n" + label)
        if default:
            print("  Enter keeps: " + str(default))
        value = input("  > ").strip() or str(default)
        try:
            if any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in value):
                raise ValueError("Please enter text without terminal control characters.")
            return validate(value) if validate else value
        except ValueError as error:
            print("  " + str(error))


def consent(value):
    value = value.lower().rstrip(".! ")
    if value in ("yes", "y", "yes please", "please do", "go ahead", "save", "start"):
        return True
    if value in ("no", "n", "no thanks", "not now", "later", "cancel"):
        return False
    raise ValueError("Please say yes or no; unclear answers never authorize changes.")


def local_path(value):
    if not value or any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in value):
        raise ValueError("Enter a local path without control characters.")
    return Path(value).expanduser().resolve()


def workspace_path(value):
    path = local_path(value)
    for generated in ((ROOT / "frontend").resolve(), (ROOT / "backend/target").resolve()):
        if path == generated or generated in path.parents:
            raise ValueError("Keep spec files outside frontend assets and backend build output; builds may publish or delete them.")
    if path.exists():
        if not path.is_dir() or path.stat().st_mode & 0o022:
            raise ValueError("Use a directory not writable by group/others; existing permissions are never changed.")
    return path


def port_number(value):
    if not value.isascii() or not value.isdecimal() or not 1 <= int(value) <= 65535:
        raise ValueError("Enter a port from 1 to 65535, normally 4780.")
    return str(int(value))


def ssh_target(value):
    if value.lower().rstrip(".! ") in ("local", "local only", "just local", "not now", "later", "no", "none"):
        return ""
    if not re.fullmatch(r"[a-zA-Z0-9_][a-zA-Z0-9_.@:\[\]-]*", value):
        raise ValueError("Enter an SSH alias or user@host, or say local. Do not paste an SSH command.")
    return value


def ssh_key(value):
    if value.lower() in ("agent", "ssh agent", "ssh config", "default"):
        return ""
    path = local_path(value)
    if not path.is_file() or not os.access(path, os.R_OK):
        raise ValueError("Enter a readable local key-file path, or say agent. Key contents are never read here.")
    return str(path)


def remote_path(value):
    if not value.startswith("/") or any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in value):
        raise ValueError("Enter the absolute project path on the remote host, not a local path or ~ alias.")
    return value


def requirements():
    print("\nTell me how you want to use Spec, in your own words.")
    print("For example: 'Edit specs locally now; use my build server and Claude later.'")
    print("Mention workflow, dependencies, AI/voice, or other constraints. No secrets.")
    print("These are notes, not commands or an AI prompt. Concrete settings are confirmed below.")
    print("Enter a blank line to finish; an empty area defaults to local editing.")
    lines = []
    size = 0
    while True:
        line = input("  | ")
        if not line.strip():
            break
        if any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in line):
            print("  Please omit terminal control characters.")
            continue
        size += len(line.encode("utf-8")) + 1
        if size > 12000:
            raise ValueError("Please keep setup notes under 12 KB.")
        lines.append(line)
    return "\n".join(lines) or "Edit and save specs locally; configure optional services later."


def dependencies(remote=False):
    """Check local prerequisites only; never install packages or connect remotely."""
    failures = []

    def check(ok, label, remedy):
        print(f"  [{'ok' if ok else 'needed'}] {label}")
        if not ok:
            failures.append(label)
            print("    " + remedy)

    def version(command, minimum):
        if not shutil.which(command):
            return False
        try:
            # Rustup shims can install a missing toolchain even for --version.
            result = subprocess.run([command, "--version"], capture_output=True, text=True, timeout=5,
                                    env={**os.environ, "RUSTUP_AUTO_INSTALL": "0"})
            match = re.search(r"(\d+)\.(\d+)\.(\d+)", result.stdout)
            return result.returncode == 0 and match is not None and tuple(map(int, match.groups())) >= minimum
        except (OSError, subprocess.TimeoutExpired):
            return False

    print("\nLocal requirements (read-only checks; no GPU or model account required):")
    check(platform.system() == "Linux", "Linux", "Windows is unsupported; macOS is not validated.")
    check(sys.version_info >= (3, 9), "Python 3.9+ for this wizard", "Install Python 3 with your OS package manager.")
    for command in ("bash", "git", "cc", "stat", "mkdir", "realpath"):
        check(bool(shutil.which(command)), command, "Install Git, Bash, a native C toolchain and GNU coreutils with your OS package manager.")
    for command in ("rustc", "cargo"):
        check(version(command, (1, 98, 0)), command + " 1.98+ (tested baseline)",
              "Install/update Rust via https://rustup.rs/ and load its environment. Older releases are not validated.")
    if shutil.which("bun"):
        check(version("bun", (1, 3, 14)), "Bun 1.3.14+ (tested baseline)", "Update Bun: https://bun.sh/docs/installation")
    else:
        check(version("node", (22, 12, 0)) and bool(shutil.which("npm")), "Node.js 22.12+ and npm (Bun fallback)",
              "Prefer Bun 1.3.14+ for the committed lockfile, or install Node.js 22.12+ and npm.")
        print("  npm fallback does not use frontend/bun.lock.")
    if remote:
        check(Path("/usr/bin/ssh").is_file() and os.access("/usr/bin/ssh", os.X_OK), "OpenSSH client /usr/bin/ssh", "Install the OpenSSH client with your OS package manager.")
        print("  Remote prerequisites are NOT checked or installed by this interview:")
        print("  Linux, Bash, setsid, flock, GNU coreutils/stdbuf, findutils, Bun or Node;")
        print("  Python 3.7+ for saved profiles/discovery, and a configured spec build engine.")
        print("  Prepare the project and tests there; verify the host fingerprint and batch SSH access.")
        print("  See docs/INSTALLATION.md and REFERENCE.md for continuation/performance requirements.")
    return failures


def output_directory(value, workspace):
    # Reject symlinks rather than resolving a user-controlled settings destination.
    path = Path(os.path.abspath(os.path.expanduser(str(value))))
    if path.exists() or path.is_symlink():
        raise ValueError("Setup destination already exists. Keep it, or use --output-dir with a NEW directory.")
    if not path.parent.is_dir():
        raise ValueError("The setup destination's parent must already exist.")
    for parent in path.parents:
        info = parent.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid not in (0, os.geteuid()):
            raise ValueError("Setup destination must have trusted, non-symlink ancestors.")
        if info.st_mode & 0o022 and not (info.st_uid == 0 and info.st_mode & stat.S_ISVTX):
            raise ValueError(f"Setup destination ancestor {parent} is writable by group/others. Choose --output-dir under a private home directory.")
    for public in (workspace, (ROOT / "frontend").resolve(), (ROOT / "backend/target").resolve()):
        if path == public or public in path.parents:
            raise ValueError("Keep setup files outside the spec workspace, frontend assets, and backend build output.")
    return path


def save_setup(directory, env, notes, profile, voice):
    directory.mkdir(mode=0o700)  # Exclusive creation: never overwrite an earlier setup.
    os.chmod(directory, 0o700)

    def write(name, content, mode=0o600):
        fd = os.open(directory / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            os.fchmod(stream.fileno(), mode)
            stream.write(content)

    env = dict(env)
    if profile is not None:
        write("profile.json", json.dumps(profile, indent=2) + "\n")
        env["SPEC_SETTINGS_FILE"] = str(directory / "profile.json")
    if voice is not None:
        # dotenvy understands double-quoted escapes; escape $ to prevent expansion.
        write("voice.env", "".join(key + "=" + json.dumps(value).replace("$", "\\$") + "\n" for key, value in voice.items()))
        env["SPEC_AZURE_VOICE_ENV_FILE"] = str(directory / "voice.env")
    write("requirements.txt", notes + "\n")
    lines = ["#!/usr/bin/env bash", "set -euo pipefail", "umask 077",
             "unset SPEC_COMMAND SPEC_SSH_BINARY SPEC_UI_DIR"]
    for tool, folder in USER_TOOLS.items():
        lines += [f'if ! command -v {tool} >/dev/null 2>&1 && [[ -x "$HOME/{folder}/{tool}" ]]; then',
                  f'  export PATH="$HOME/{folder}:$PATH"', "fi"]
    if voice is not None:
        lines.append("unset " + " ".join(voice))
    lines += ["export " + key + "=" + shlex.quote(value) for key, value in env.items()]
    command = "exec bash " + shlex.quote(str(ROOT / "run.sh"))
    if not env["SPEC_SSH_TARGET"]:
        command += " --local"
    lines.append(command)
    # Write the launcher last. Incomplete setup never has a launchable entry point.
    write("start.sh", "\n".join(lines) + "\n", 0o700)
    return directory / "start.sh"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--no-animation", action="store_true", help="Use static terminal output")
    parser.add_argument("--check", action="store_true", help="Check local dependencies only; no interview or writes")
    parser.add_argument("--dry-run", action="store_true", help="Interview and review only; no writes, downloads, SSH, or launch")
    parser.add_argument("--output-dir", type=Path, default=Path.home() / ".spec-setup", help="NEW private setup directory (default: ~/.spec-setup)")
    args = parser.parse_args(argv)
    saved = None
    try:
        if sys.version_info < (3, 9):
            raise ValueError("The wizard needs Python 3.9+. See docs/INSTALLATION.md for the Bash-only launch path.")
        for tool, folder in USER_TOOLS.items():
            installed = Path.home() / folder
            if not shutil.which(tool) and os.access(installed / tool, os.X_OK):
                os.environ["PATH"] = str(installed) + os.pathsep + os.environ.get("PATH", os.defpath)
                print(f"Using already-installed {tool} from {installed}")
        if args.check:
            return int(bool(dependencies()))
        launch(enabled=not args.no_animation)
        print("This sets up the Spec WEB APP, not the separate spec build engine.")
        print("No menus: type answers, or press Enter for defaults. Ctrl+C cancels.")
        print("No packages, permissions, services, or existing configuration are changed by the interview.")
        notes = requirements()
        default_workspace = Path.home() / "specs"
        suffix = 0
        while True:
            try:
                workspace_path(str(default_workspace))
                break
            except ValueError:
                suffix += 1
                if suffix >= 100:
                    raise ValueError("Could not suggest a safe workspace under your home directory.")
                default_workspace = Path.home() / ("specs-private" + (f"-{suffix}" if suffix > 1 else ""))
        if suffix:
            print("The usual ~/specs location is not suitable; suggesting a private alternative without changing existing files.")
        workspace = ask("Where should your spec files live? Existing files are edited in place; back them up.",
                        str(default_workspace), workspace_path)
        port = ask("Which loopback port should the editor use?", "4780", port_number)
        target = ask("Where should coding runs execute? Enter your SSH alias or user@host; say local for editing only.", "local", ssh_target)
        env = {"SPEC_WORKSPACE": str(workspace), "SPEC_PORT": port,
               "SPEC_SSH_TARGET": target, "SPEC_SSH_KEY": "", "SPEC_SSH_WORKSPACE": ""}
        if target:
            print("SSH runs can change remote files and incur costs; this is not a sandbox.")
            print("Your project must already be on the remote host. Spec does not sync source code.")
            env["SPEC_SSH_KEY"] = ask("How should SSH authenticate? Enter a LOCAL private-key path, or say agent.", "agent", ssh_key)
            env["SPEC_SSH_WORKSPACE"] = ask("What is the full path to your prepared project on the REMOTE host?", validate=remote_path)
        directory = output_directory(args.output_dir, workspace)
        profile, voice = collect_ai(ask)
        checklist = io.StringIO()
        with progress("Checking local prerequisites", enabled=not args.no_animation), redirect_stdout(checklist):
            missing = dependencies(remote=bool(target))
        print(checklist.getvalue(), end="")
        print("\nReview before saving")
        print("  Requirements (notes only):\n" + "\n".join("    " + line for line in notes.splitlines()))
        for key, value in env.items():
            print("  " + key + ": " + (value or "(none / agent for SSH key)"))
        print("  AI: " + (f"{profile['provider']} / {profile['model']} / {profile['endpoint']} (key hidden)" if profile else "inherit launch environment and workspace-default settings"))
        if profile:
            print("  API version: " + (profile["apiVersion"] or "provider default"))
        print("  Azure voice: " + ("new private voice file (key hidden)" if voice else "inherit launch environment and default dotenv"))
        if voice:
            for key, value in voice.items():
                if key != "AZURE_OPENAI_VOICE_API_KEY":
                    print("  " + key + ": " + value)
        print("  New private setup directory: " + str(directory))
        print("  Missing prerequisites: " + (", ".join(missing) if missing else "none detected"))
        print("  Custom requirements are retained as notes, not automatically implemented.")
        print("  No API/provider reachability or remote engine validation has been performed.")
        print("  Existing AI files are untouched. Previous wizard profiles are NOT imported into a new setup.")
        print("  Reuse their saved launcher to keep those profiles. --local only disables SSH.")
        if args.dry_run:
            print("Dry run complete: nothing saved, downloaded, connected, or started.")
            return 0
        if not ask("May I save this setup? Keys, if supplied, are private plaintext files, not encrypted.", "no", consent):
            print("Cancelled; nothing saved or started.")
            return 0
        saved = save_setup(directory, env, notes, profile, voice)
        print("\nSaved. Start now or later with:\n  " + shlex.join(["bash", str(saved)]))
        if missing:
            print("Install the missing prerequisites above, then use the saved launcher. Nothing started.")
            return 0
        print("Starting installs frontend dependencies, builds Rust, and runs the local web server.")
        if target:
            print("It also connects with strict host-key checking and may create the remote project directory.")
        print("It does not install OS packages, model runtimes, remote engines, or a system service.")
        if not ask("May I download build dependencies and start Spec now?", "no", consent):
            return 0
        print("Open the FULL printed URL, including #token. Keep it private. Ctrl+C stops the server.", flush=True)
        return subprocess.call(["bash", str(saved)])
    except (EOFError, KeyboardInterrupt):
        print("\nStopped. " + ("Saved setup remains at " + str(saved) if saved else "No application launched; any incomplete setup directory is left for inspection."), file=sys.stderr)
        return 130
    except (OSError, ValueError, RuntimeError) as error:
        print("Setup error: " + str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

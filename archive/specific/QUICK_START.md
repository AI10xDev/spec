# Quick Start

1. Clone and enter the repository.

   ```bash
   git clone https://github.com/AI10xDev/specific.git
   cd specific
   ```

2. Install the editor and commands.

   ```bash
   ./install.sh
   ```

3. Load the shell integration now, then add the same line to your Bash startup
   file when ready.

   ```bash
   source "${XDG_DATA_HOME:-$HOME/.local/share}/specific/shell/specific.sh"
   ```

   Alternatively, `./install.sh --configure-shell` adds the resolved line to
   `~/.bashrc` idempotently.

4. Verify the installation.

   ```bash
   type spec
   specific-run-build --help
   specific-run-plan --help
   ```

5. Open a target project and write the first specification.

   ```bash
   cd /path/to/your/project
   spec first-feature.md
   ```

   Press `Ctrl+R` to save and build without leaving the editor. An unnamed
   buffer first prompts with Save As. The noninteractive build streams output
   to the left pane, not into your spec. Or save only with `Ctrl-S`.

   To locate a project file, press `Ctrl+:` (`Ctrl+T` fallback), type into the
   **File query:** input below the editor, then press `Enter` to search. Query
   text does not modify your spec. Use arrows to select a ranked filename,
   `Enter` to insert its path below the document cursor, or `Ctrl+O` to open it
   directly in Kibi. If there are unsaved changes, `Ctrl+S` in the picker saves
   them before `Ctrl+O`. A running build is detached, not stopped. `Esc` cancels;
   `Ctrl+U` clears the query.
   See [filename search](README.md#filename-search-in-spec--kibi) for Azure settings.

6. For the portable foreground workflow, quit with `Ctrl-Q`, then send the file
   to OpenCode's build agent from your shell. Quitting stops any active editor job.

   ```bash
   spec build first-feature.md
   ```

7. Use the latest-save shortcut after saving any specification with `spec`.

   ```bash
   spec build
   ```

8. Select a specification for OpenCode's plan agent.

   ```bash
   plan_goal
   # Or choose another source directory:
   plan_goal "$HOME/specs"
   ```

Azure-backed inline completion is optional. Leave `KIBI_ENV_FILE` and all
`AZURE_OPENAI_*` variables unset to omit it. Core editing and delegation still
work. See the [complete configuration](README.md#configuration) and
[troubleshooting guide](README.md#troubleshooting).

## Editor Shortcuts

`Ctrl+E` prompts for an arbitrary shell command, executes it with `bash -c`,
and streams output to the live left pane without inserting it into the buffer.
`Ctrl+K` removes a line, replacing the old `Ctrl+R` binding. The editor prevents
overlapping runs. Output auto-tails a bounded number of retained lines; older
output is discarded and manual output scrolling is not available.

The shell integration supplies `KIBI_RUN_COMMAND` for `Ctrl+R`. To override it,
set it to an executable path, not a shell command string. The saved filename is
passed as one argument, including when paths contain spaces. This does not
change `spec build`; see [Configuration](docs/CONFIGURATION.md#editor-commands).

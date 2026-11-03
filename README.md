# Spec In Everyday Development

Spec gives you a place to describe a coding task in plain language, save it, and
view an AI coding run's output beside it. Think of a **spec** as a short work
request: what is wrong, what should change, and how you will check the result.
You do not need a formal requirements document.

Start with a small task such as fixing a form, adding a filter, or improving a
README. Spec helps organize that work; you still review and test the changes.

## Choose Your Starting Point

| I want to... | Start here |
| --- | --- |
| Try the editor and save task descriptions | [Install and open Spec](#install-and-open-spec). No AI account or remote server needed. |
| Have an AI work on my project | Try the editor first, then [enable coding runs](#optional-enable-coding-runs). This requires a separately prepared development server. |
| Write clearer tasks | Use the [everyday examples](#everyday-examples). |
| Understand every setting | Read [Installation](docs/INSTALLATION.md) and the [configuration reference](REFERENCE.md#configuration). |

## Install And Open Spec

### 1. Prepare Your Computer

Use a Linux computer. Windows is not supported by this version; macOS has not
been validated. You need an internet connection for the initial downloads.

Install these tools first if you do not already have them:

- **Git**, to download the project.
- **Rust and Cargo**, to build the app. Follow [rustup](https://rustup.rs/); this release was tested with Rust 1.98.
- **Bun**, to prepare the browser interface. Follow [Bun's installation guide](https://bun.sh/docs/installation); this release was tested with Bun 1.3.14. Node.js 22.12 or newer with npm is an alternative.
- **Linux build tools**. On Ubuntu or Debian, `sudo apt-get install build-essential git` installs the native build tools and Git.

Open a new terminal after installing the tools. These checks should print version
numbers rather than "command not found":

```sh
git --version
cargo --version
bun --version
```

If you chose Node.js instead of Bun, check `node --version` and `npm --version`.
There is no prebuilt app installer in v0.1.12, so the first launch builds the app
on your computer. You do not need a GPU.

### 2. Download And Start

In a terminal, from a folder where you keep projects, run:

```sh
git clone --branch v0.1.12 https://github.com/AI10xDev/spec.git
cd spec
unset SPEC_COMMAND
./run.sh --local
```

This downloads a known release and starts Spec without remote coding runs.
`unset SPEC_COMMAND` clears an old setting that this version no longer accepts;
it is harmless if you have never set it. A Git "detached HEAD" notice is expected
when downloading a release tag; it is not an installation error.

Wait for the build to finish. Open the **full address printed in the terminal**,
including its `#token=...` part. It normally starts with
`http://127.0.0.1:4780`. The token is your private access link: do not share it or
make the server public.

Keep the terminal running while using the app. Press **Ctrl+C** there to stop
the local app. Next time, run `./run.sh --local` from the same `spec` folder and
open the newly printed link; the previous token will no longer work.

### 3. Save Your First Task

1. In the sidebar's **New filename** field, enter `fix-contact-form.md`.
2. Click the adjacent **+** button, labeled **Create file**.
3. Enter a short task, for example: "Show a helpful error when the contact form's email address is missing. Keep the rest of the form unchanged."
4. Click **Save**. Confirm that the unsaved indicator clears.
5. Open the file from **Saved files** to return to it later.

Edited active tabs also autosave, but an explicit Save is a useful habit before
leaving. Saving stores the task; **it does not change your application's code**.
In local mode, **Save & run** is disabled. That is expected, not a setup failure.

Your files normally live in the `workspace/` folder inside the Spec checkout.
To keep them separately, stop the app and use this command for future launches:

```sh
SPEC_WORKSPACE="$HOME/specs" ./run.sh --local
```

This selects a folder for your task files, not the application's source code.
Existing files there are edited in place, so back them up if needed. Use a flat
folder of ordinary text files, not nested folders or links to files elsewhere.

## Optional: Enable Coding Runs

Skip this section if you only want to write and organize specs.

**Installing this app does not install the AI coding engine.** Coding runs use
SSH, a secure connection to another Linux machine where your project and coding
engine are already installed. You may need help from whoever manages your team's
development server.

Before continuing, you or that person must:

1. Put a checkout of your project on a trusted development server, with its dependencies and tests ready. Use a separate branch for the task.
2. Install and configure a compatible `spec build` launcher, such as [Specific](https://github.com/AI10xDev/specific), and its AI engine/account on that server. This web app's server binary is not that launcher.
3. Complete the [remote setup checklist](docs/INSTALLATION.md#enable-remote-builds), including making the launcher available to noninteractive SSH commands and installing its helper tools.
4. Connect over SSH once, verify the server's identity through a trusted channel, and confirm you can sign in. The app cannot stop to ask for a password or key passphrase; use an SSH agent for an encrypted key.

Stop the local-only app. From the Spec folder on **your own computer**, start it
with your actual connection details:

```sh
unset SPEC_COMMAND
SPEC_WORKSPACE="$HOME/specs" \
SPEC_SSH_TARGET="user@build-host" \
SPEC_SSH_KEY="$HOME/.ssh/spec_ed25519" \
SPEC_SSH_WORKSPACE="/home/user/my-app" \
./run.sh
```

Replace the example values before running:

| Setting | What to put there |
| --- | --- |
| `SPEC_WORKSPACE` | The folder on your computer where you save task descriptions. Use the same folder as before to keep seeing those files. |
| `SPEC_SSH_TARGET` | Your server login and address, or a configured SSH host alias. |
| `SPEC_SSH_KEY` | An existing private-key file on your computer. Use `SPEC_SSH_KEY=""` instead if your SSH configuration/agent already supplies the identity. |
| `SPEC_SSH_WORKSPACE` | The full path to your project's checkout on the server. |

Do not simply drop `--local` without supplying your settings: the launcher's
defaults refer to the original developer's machine setup.

**Your local project files are not synced.** Spec uploads the saved task
description, not your project's source tree. It does not install your project's
dependencies or copy changed code back to your computer. Review the changes in
the server's checkout and bring them back through your normal Git workflow.

Use a development environment, not production. A coding run can edit files,
execute commands, use available credentials, and incur AI charges. Automatic
tool approval is requested; the confirmation dialog is not a sandbox. Do not
give it customer data, secrets, or access it does not need.

### What About AI Settings?

**Settings** lets you configure a provider for optional chat and writing
suggestions, and select a profile for future agent runs. It does not install the
remote engine or download a local model. You can skip it for basic editing.

For remote runs, a saved AI profile, including its API key, is sent over SSH to a
private temporary file on the server. Trust that server and the account running
the agent with those credentials. Settings are stored privately, but are not
encrypted at rest.

`--local` disables remote builds, not previously configured AI features. Writing
suggestions can send unsaved text to the selected provider. Keep API keys in
Settings, not in your specs, and see [AI settings](REFERENCE.md#ai-settings) before
using sensitive material.

## Your First Bug-Fix Run

Once remote setup is working, expand `fix-contact-form.md` into a task like this.
Replace the project path with your real remote checkout path:

```text
## Where to work
Use /home/user/my-app on the branch fix/contact-form.

## Problem
Submitting the contact form with an empty email gives no useful feedback.

## Expected result
Show an error beside the email field when it is empty or invalid.
Keep the user's message so they do not have to type it again.
Keep valid submissions working as before.

## Boundaries
Use the existing form styling and validation approach.
Do not add dependencies or change unrelated pages.
Do not commit, push, deploy, or contact production services.

## Check the work
Find and run the project's documented checks for this form.
Add a test for empty and invalid email input.
Report the changed files, test commands and results, and anything not checked.
```

1. Confirm the remote checkout is on the intended branch and has no conflicting work. A branch name in the spec is not proof of the checkout's current state.
2. Click **Save & run**, read the warning, and confirm. Output appears beside the spec.
3. When the run finishes, read its summary and inspect the actual code changes on the server. `git status` and `git diff` there are useful starting points.
4. Run the project's relevant tests. Try the form yourself with empty, invalid, and valid input, including on a narrow screen. A successful run status does not prove the change is correct.
5. If something is missing, give a specific follow-up such as "The error disappears when I resize the page. Fix that and add a regression test."
6. Once verified, commit and open a pull request through your normal review process. Spec does not make review or deployment decisions for you.

### Save, Run, Or Continue?

| What you want | What to use |
| --- | --- |
| Keep your writing without starting work | **Save**. |
| Run the requirements currently in the editor | **Save & run**, after the previous run is resolved. |
| Ask a successful build to do one more thing | Type the instruction in feedback and use **Send & continue**, when available. |
| Ask about the task or output without changing code | **Session chat**, if an AI provider is configured. This is separate from the coding agent. |

**Continue does not send editor changes**, even if they autosaved. If you rewrote
the spec, use a new **Save & run** instead. Do not start another run against the
same project just because output is quiet; first check whether the current one
is still working.

### Track What You Have Checked

After you verify a requirement, place the cursor on its line and press **/** to
mark it complete. Press it again to reopen the requirement. Use **Alt+/** when
you want to type an ordinary slash outside code blocks.

The saved text uses `# ` for a completed line:

```text
## Contact form
# Show an error beside the email field when it is empty or invalid.
Keep the user's message so they do not have to type it again.
```

Here, only the error-message requirement is complete. Use `##` for headings in
your specs, not `# `, so a heading is not mistaken for completed work. Marked
lines remain context; the agent is instructed to work on the pending lines.

## Everyday Examples

Keep each example in its own file. Add the real project location and any known
test commands before running. Prefer one change you can review in a sitting to
"build the entire product."

### Add A Small Feature

Save as `filter-orders.md`:

```text
Add an "Open orders only" checkbox above the existing orders list.
Leave the current list unchanged when the checkbox is off.
When it is on, show only open orders and a clear message if there are none.
Follow the existing page styling. Do not change the database or add packages.
Test switching the filter on and off, including an empty result.
Run the relevant existing checks and report what you could not verify.
Do not commit, push, or deploy.
```

Before marking this done, try the empty state and verify that switching the
filter off restores all orders.

### Understand Unfamiliar Code

Save as `understand-login.md`:

```text
Explain how sign-in works in this project, from the form to the session.
Do not edit files or run commands that change data.
Identify the main source files and existing tests.
Explain where a "remember me" option would fit and any risks to discuss first.
Propose a small implementation plan, but do not implement it yet.
```

Review that explanation before authorizing changes in a later task. "Do not
edit" is an instruction to the agent, not an enforced read-only environment.

### Improve Project Documentation

Save as `improve-setup-guide.md`:

```text
Improve the README so a new teammate can run this project locally.
Check the current scripts before documenting commands.
Explain prerequisites, setup, starting the app, and running tests.
Include common setup problems and how to recognize a successful launch.
Do not change application code or include real credentials.
Check the links and report which commands you actually tested.
Do not commit or push.
```

Try the resulting steps from a clean development checkout before relying on
them for onboarding. An installation command written in a document is not
evidence that it worked.

## A Routine That Works

- **Before starting:** pick one outcome, use a dedicated branch, and note the starting state. Preserve unrelated work.
- **While writing:** describe an observable result, what must stay unchanged, and how to check it. Replace "make it better" with concrete examples.
- **During the run:** read warnings and watch costs. Runs have no overall time limit; a keep-alive message only means the process is still alive.
- **Before merging:** review the diff, tests, and user-visible behavior. Keep unverified requirements pending.
- **With teammates:** share reviewed specs and pull requests, not the app's access token or private logs. Different spec filenames do not isolate changes to a shared checkout; use separate checkouts for parallel work.

## When Something Goes Wrong

| What you see | What to do |
| --- | --- |
| `cargo`, `bun`, or `npm` is missing | Finish installing the prerequisite, reopen the terminal, and retry. For a linker error on Ubuntu/Debian, check that `build-essential` is installed. |
| A complaint about `~/ip` or an SSH key when you only want the editor | Start with `./run.sh --local`. |
| The browser says unauthorized after restarting | Open the new full token URL printed by the server. |
| The port is already in use | Stop the previous local app, or launch with `SPEC_PORT=4781 ./run.sh --local` and follow its printed URL. |
| Save & run is disabled | It is expected in local mode. If remote execution is configured, check whether an earlier run is active or unresolved. |
| A save conflict appears | **Download** your draft first. Close its editor tab and confirm discarding that editor copy, then refresh **Saved files**, reopen the file, and merge your changes. Selecting the already-open tab will not reload it. |
| The browser closed or the connection dropped during a build | Reopen the app and saved spec, then use **Load nohup output** or **Active runs** to inspect the existing run before retrying. |
| You need to stop a build | Use **Stop run** and check that cancellation is confirmed. Closing the browser or stopping the local app normally does not stop an uploaded remote build. |
| The agent cannot find your project or engine | Check the remote checkout path and [remote installation checklist](docs/INSTALLATION.md#enable-remote-builds). Installing something locally does not install it on the server. |

For more detail, see [Development workflows](docs/WORKFLOWS.md), the
[workspace guide](docs/FEATURES.md), and
[installation troubleshooting](docs/INSTALLATION.md#troubleshooting).

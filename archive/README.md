# Original source collection (read-only reference)

Captured 2026-10-05 for the review and Rust + Vite rewrite. Files are copied from actual working trees, including uncommitted source edits. They are not automatically built, installed, or executed by the new application.

## Contents

- `specific/`: customized Kibi Rust source, Cargo manifests/lockfile, syntax definitions, Python completion/ranking helpers, tests, portable shell integration/build launchers, installer, primary documentation, and license notices. Original source: `/home/opencode/final_spec/specific`, remote https://github.com/AI10xDev/specific.
- `shell/spec.bash`: only the active `spec()` function extracted from the interactive shell; unrelated aliases and startup configuration are excluded.
- `shell/spec-launcher.bash`: source of the executable targeted by `/home/opencode/.local/bin/spec`, originally `/home/opencode/nextweb/tools/eval/spec`.
- `opencode/script/`: active build/plan launchers, persistent session runner, workflow dispatcher, telemetry helper, and related documentation.
- `opencode/packages/opencode/test/cli/`: selected original runner/workflow tests and their local process fixture.
- `opencode/LICENSE`: OpenCode's existing MIT license.
- `manifest.json`: upstream URLs, base checkout revisions, and SHA-256 hashes identifying actual copied source content.

## Collection limits

This collection covers the editor and reviewed integration feature, **not the whole OpenCode monorepo or all nextweb evaluation services**. The archived dispatcher still references OpenCode agent/command definitions and protocol types outside this collection. The machine function references `run_goal`, legacy evaluation, and other existing host commands. These are not claimed to be standalone portable programs here.

The upstream `specific` repository also contains an earlier `live-source/` collection with its own manifest, integration definitions, runtime patch, and nextweb eval sources; consult [the upstream repository](https://github.com/AI10xDev/specific) for that archive. That older collection is not silently represented as the current working tree.

Excluded: `.git` history, binaries, dependency caches, generated builds, screenshots from the original machine, environment files, credentials, user specs, save-history contents, logs, private runtime inboxes, unrelated shell aliases, and service state. Original source references to local paths/environment variable names remain as provenance, not copied secrets.

Nothing in this directory is needed at runtime by the Rust/Vite rewrite. Its legacy Bash/Python/TypeScript content is retained specifically because source collection and review were requested. Keep applicable notices when redistributing; no license for a separate upstream project is expanded by including an integration reference.

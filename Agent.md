# Global Build Permissions

Permissive development policy for supervised spec builds on this host, based on
the generated example. Permissions are ceilings for GPT-Sol's per-request review,
not automatic grants. Only the JSON block and its rules field are consumed.

```spec-build-policy
{
  "version": 1,
  "maxTokens": null,
  "reviewTimeoutMs": 120000,
  "runTimeoutMs": 3600000,
  "maxFixes": 2,
  "rules": "Implement the requested snapshot and make routine implementation decisions using project conventions. Allow local inspection, search, edits, dependency installation, builds, tests, formatting, and cleanup of generated artifacts. Allow required writes to normal development caches and temporary directories. Allow Git reads, fetches, local branches, and repository-local configuration. Allow commits, pushes, repository creation, issues, and pull requests when requested by the snapshot for AI10x repositories named in the snapshot or workspace remotes; verify the account and target repository. Also allow authenticated AI10x access to AI10xDev/spec (ai10xdev/spec). For comit_spec, authorize committing the intended changes in /home/opencode/spec and non-force pushing to https://github.com/AI10xDev/spec.git on main after reviewing status, diff, recent commits, branch and remotes. AI10xDev/model is not a target for this task. Start comit_spec with /home/opencode/spec as its workspace; if launched elsewhere, report the required workspace. Request individual command approvals, not blanket permission to reopen, delegate or approve future commands. Use existing CLI authentication without exposing secrets. Allow read-only Azure CLI operations across resource groups in subscription a8ba4251-c3cc-453f-9eee-38cb19ee6c9d; region-scoped operations must use eastus. Do not provision or mutate infrastructure, incur infrastructure spending, modify global Git configuration, rewrite shared Git history, or delete unrelated work. Deny requests with unclear external targets.",
  "cli": [
    "git", "gh", "az",
    "bun", "npm", "npx", "node", "pnpm", "yarn",
    "cargo", "rustc", "python3", "pip", "pip3", "pytest", "make", "cmake",
    "bash", "sh", "ls", "pwd", "find", "rg", "grep", "cat", "head", "tail",
    "sed", "awk", "sort", "uniq", "wc", "xargs", "jq",
    "mkdir", "mktemp", "cp", "mv", "rm", "touch", "chmod", "ln",
    "readlink", "realpath", "stat", "env", "which",
    "curl", "wget", "tar", "unzip", "zip"
  ],
  "githubAccounts": ["AI10x", "ai10x", "AI10xDev", "ai10xdev"],
  "regions": ["eastus"],
  "infrastructure": false
}
```

The CLI allowlist includes development, shell, search, file-management, download,
GitHub and Azure tools. GitHub access uses the verified account AI10x and includes
AI10xDev/spec. Canonical and lowercase account names are listed because scope
matching is case-sensitive. Azure read-only access uses the configured
subscription and the example's eastus region.
Infrastructure mutation is disabled, as in the generated example.

Allowlist entries must be explicit names; wildcards are not supported. Additional
accounts, regions or infrastructure permissions must be recorded in the JSON.
Never store API keys, tokens or passwords here.

## Commit-spec workspace

Start `comit_spec` as a new build/session with `/home/opencode/spec` as its working
directory and `AI10xDev/spec` branch `main` as the push target. The supervisor
runner hard-disables external-directory access and task delegation independently
of this policy. Its workspace cannot be switched through an approval question.
A new supervised run reloads this file.

## Token budget

`maxTokens` is `null`, so no reported-token cap is enforced for a sweep. Usage
is still counted across both agents, including input, output, reasoning and
cache tokens. Review/run timeouts and all other safeguards remain enabled.
Use provider-side quotas for a strict spending limit.

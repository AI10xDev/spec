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
  "rules": "Implement the requested snapshot and make routine implementation decisions using project conventions. Allow local inspection, search, edits, dependency installation, builds, tests, formatting, and cleanup of generated artifacts. Allow required writes to normal development caches and temporary directories. Allow Git reads, fetches, local branches, and repository-local configuration. Allow commits, pushes, repository creation, issues, and pull requests when requested by the snapshot for AI10x repositories named in the snapshot or workspace remotes; verify the account and target repository. Also allow authenticated AI10x access to AI10xDev/spec (ai10xdev/spec). For comit_spec, authorize committing the intended changes in /home/opencode/spec and non-force pushing to https://github.com/AI10xDev/spec.git on main after reviewing status, diff, recent commits, branch and remotes. AI10xDev/model is not a target for comit_spec. Start comit_spec with /home/opencode/spec as its workspace; if launched elsewhere, report the required workspace. Request individual command approvals, not blanket permission to reopen, delegate or approve future commands. Use existing CLI authentication without exposing secrets. Allow Azure CLI operations across resource groups in subscription a8ba4251-c3cc-453f-9eee-38cb19ee6c9d, including provisioning or mutating infrastructure and incurring infrastructure spending when required by the requested snapshot and individually approved. Do not modify global Git configuration, rewrite shared Git history, or delete unrelated work. Deny requests with unclear external targets. The following task scope covers the frontier_reverse GPU evaluation workflow, including snapshots named frontier_convert_open. Allow independent non-secret Azure/GitHub identity checks and Azure SSH extension inspection, installation and updates. Interpret admin@ai10x as the Azure identity admin@ai10x.dev, not an SSH hostname or VM username. Before VM discovery, each VM-management invocation or each new SSH connection, run az account show with explicit subscription a8ba4251-c3cc-453f-9eee-38cb19ee6c9d and require identity admin@ai10x.dev, identity type user, that subscription ID, tenant d351cc3d-e00b-47a1-b365-a1ee43564ba5 and state Enabled. Account query failure, missing fields or any mismatch must prevent the VM query and all dependent actions. Pass the explicit subscription to every Azure command that accepts it. After that live account guard, allow read-only az vm list or az vm show to establish VM eligibility in the same invocation. Candidate-scoped az vm show --show-details may retrieve eligibility metadata and SSH details together without prior discovery evidence; require a returned resource ID in the allowed subscription, matching resource group/name, location australiaeast, australiasoutheast, australiacentral or australiacentral2, and hardwareProfile.vmSize in the Standard_NC, Standard_ND or Standard_NV GPU families before using the SSH details or performing VM access/mutation. Compare Azure resource IDs case-insensitively. VM query failure, missing eligibility fields or a mismatch must prevent dependent actions. RG-H100-AUE/h100-aue is a candidate, not permanently verified context. The reviewer may approve these self-contained guarded discovery, SSH-detail and follow-up invocations by inspecting the inline checks or a readable workspace script. Do not require earlier discovery output when the current invocation independently verifies account and VM eligibility before the dependent operation; an earlier approval alone never proves its result. Explicitly enumerated, bounded task steps may share one guarded invocation or established SSH session; do not require a new identity check for each GPU batch inside that approved operation. Allow starting the existing verified VM if stopped, az vm run-command invoke for task setup or reading public SSH host keys, and temporary SSH ingress restricted to the connecting client's IP with cleanup of task-created rules. Allow SSH login, loopback-only port forwarding and task-scoped scp/rsync transfers to the verified VM using existing authorized credentials and the discovered address and username. Allow task SSH configuration and known-hosts files; verify a host key against an existing trusted key or a public key obtained through authenticated Azure VM management. ssh-keyscan alone is not verification; do not disable host-key checking. Allow reading and cloning AI10xDev/model (ai10xdev/model), inspecting GPU processes, service/container logs and existing model deployments, and using its deployment or prioritizing an existing RL-trained open-model deployment if unavailable. Clone source and output repositories into separate subdirectories of the current build workspace rather than changing the supervisor workspace or replacing its Git repository. Allow isolated task directories, virtual environments, dependency/package installation, model downloads from authorized source/deployment configuration or official registries, and necessary sudo for package, GPU/container runtime and SSH setup on the verified VM. Preserve unrelated services, deployed checkpoints and existing credentials. Allow task-owned GPU jobs, bounded background execution, progress/log/resource inspection, checkpointing and stopping only task-owned processes. Allow fixed-dataset GPU inference/evaluation cycles, GPT-Sol reference inference through the configured provider, and required GPU runtime and model API costs under individual command review. Task evaluation inputs may be sent to that configured GPT-Sol service using existing credentials in process memory, without logging or publishing credentials or unrelated private data. Allow implementing the optimization path before collecting baseline results, but execute backward-pass updates only on a separate working copy of open-model weights after a measured miss of the declared near-zero accuracy-gap target against GPT-Sol and a measured plateau. A reviewed driver may enforce these conditions from actual metrics at runtime; absent earlier evaluation output alone does not bar a correctly guarded driver. Preserve original deployed checkpoints and rerun the identical held-out evaluation after every update. Allow documented configurable defaults for parity tolerance, plateau window and bounded evaluation/update counts when unspecified by the snapshot. Allow CLI dataset-path flags, clearly labelled mocked fallback data when no evaluation dataset is available, accuracy traces, tests and sanitized reports. Keep evaluation data separate from weight-optimization data; never present mocked data or mocked reference results as genuine GPT-Sol parity or real benchmark evidence. Allow git init, creation of AI10xDev/frontier_reverse (ai10xdev/frontier_reverse), and commits and non-force pushes of intended code, tests, documentation and sanitized evaluation reports after reviewing status, diff, branch and remotes and verifying the GitHub identity, owner and repository. Live GitHub checks and the conditional repository operation may be reviewed together without earlier check output; an absent target repository is expected when creating it. Create it private unless public visibility is explicitly requested. Do not push to AI10xDev/model or overwrite the running deployment for this spec. Never publish secrets; publishing private datasets or model weights to GitHub or other unrelated destinations requires explicit authorization. These enumerated task stages need no further policy exception merely because they are follow-up operations, but each concrete command still receives the coordinator's normal one-time review. Shell builtins and syntax are part of the approved shell; declare actual external executables in the CLI scope. Existing timeouts, workspace confinement and the prohibition on delegation remain in force.",
  "cli": [
    "git", "git-lfs", "gh", "az",
    "ssh", "scp", "rsync", "ssh-keygen", "ssh-keyscan",
    "nvidia-smi", "docker", "torchrun", "accelerate", "deepspeed", "vllm", "hf", "huggingface-cli", "ps", "ss",
    "sudo", "apt", "apt-get", "dpkg", "systemctl", "journalctl",
    "timeout", "nohup", "sleep", "pgrep", "kill", "pkill",
    "df", "du", "free", "lscpu", "uname", "id", "whoami", "hostname", "date", "time",
    "bun", "npm", "npx", "node", "pnpm", "yarn",
    "cargo", "rustc", "python", "python3", "pip", "pip3", "pytest", "make", "cmake",
    "uv", "uvx", "conda", "mamba", "micromamba",
    "bash", "sh", "ls", "pwd", "find", "rg", "grep", "cat", "head", "tail",
    "sed", "awk", "sort", "uniq", "wc", "xargs", "jq", "cut", "tr", "tee", "printf",
    "mkdir", "mktemp", "cp", "mv", "rm", "touch", "chmod", "ln",
    "readlink", "realpath", "stat", "env", "which", "file", "sha256sum",
    "curl", "wget", "tar", "unzip", "zip"
  ],
  "githubAccounts": ["AI10x", "ai10x", "AI10xDev", "ai10xdev"],
  "regions": [
    "eastus", "westus2", "australiaeast", "southeastasia",
    "northeurope", "swedencentral", "westeurope", "uksouth",
    "centralus", "southafricanorth", "centralindia", "eastasia",
    "indiasouthcentral", "indonesiacentral", "japaneast", "japanwest",
    "koreacentral", "malaysiawest", "newzealandnorth", "southeastasia3",
    "taiwannorth", "canadacentral", "austriaeast", "belgiumcentral",
    "denmarkeast", "francecentral", "germanywestcentral", "italynorth",
    "norwayeast", "polandcentral", "spaincentral", "switzerlandnorth",
    "mexicocentral", "uaenorth", "brazilsouth", "chilecentral",
    "eastus2euap", "israelcentral", "qatarcentral", "centralusstage",
    "eastusstage", "eastus2stage", "northcentralusstage", "southcentralusstage",
    "westusstage", "westus2stage", "asia", "asiapacific",
    "australia", "austria", "belgium", "brazil",
    "canada", "chile", "denmark", "europe",
    "finland", "france", "germany", "global",
    "india", "indonesia", "israel", "italy",
    "japan", "korea", "malaysia", "mexico",
    "newzealand", "norway", "poland", "qatar",
    "saudiarabia", "singapore", "southafrica", "spain",
    "sweden", "switzerland", "taiwan", "uae",
    "uk", "unitedstates", "unitedstateseuap", "eastasiastage",
    "southeastasiastage", "eastus2", "eastusstg", "southcentralus",
    "westus3", "northcentralus", "westus", "jioindiawest",
    "centraluseuap", "southcentralusstg", "westcentralus", "southafricawest",
    "australiacentral", "australiacentral2", "australiasoutheast", "jioindiacentral",
    "koreasouth", "southindia", "westindia", "canadaeast",
    "francesouth", "germanynorth", "norwaywest", "switzerlandwest",
    "uaecentral", "brazilsoutheast", "ukwest"
  ],
  "infrastructure": true
}
```

The CLI allowlist includes development, shell, search, file-management, download,
GitHub, Azure, SSH and GPU tools. GitHub access uses the verified account AI10x.
AI10xDev/spec remains the comit_spec target; the frontier_reverse scope permits
reading AI10xDev/model and creating/writing AI10xDev/frontier_reverse.
Canonical and lowercase account names are listed because scope matching is
case-sensitive. Azure access uses the configured subscription; the
region allowlist includes all locations returned for it on 2026-11-14.
Infrastructure mutation and spending are permitted when required by the requested
snapshot and individually approved.

Allowlist entries must be explicit names; wildcards are not supported. Additional
accounts or regions must be recorded in the JSON.
Never store API keys, tokens or passwords here.

## GPU evaluation scope

The `frontier_reverse` workflow, including `frontier_convert_open` snapshots, may
use an existing Australian GPU VM, read
`ai10xdev/model`, run GPU/GPT-Sol evaluations and optimize a separate copy of the
open-model weights when the declared parity/plateau conditions are met. Evaluation
data must stay separate from optimization data; mocked fallback results must be
labelled. Original deployments/checkpoints must be preserved.

Non-secret account checks and SSH extension setup may be approved separately.
For discovery, VM-management calls and new SSH connections, request the live
account check, VM eligibility check and dependent operation together. Stop unless the
current principal is `admin@ai10x.dev`, its type is `user`, the subscription is
`a8ba4251-c3cc-453f-9eee-38cb19ee6c9d`, the tenant is
`d351cc3d-e00b-47a1-b365-a1ee43564ba5`, and its state is `Enabled`.

After the account guard, `az vm show --show-details` is itself permitted discovery:
include the resource ID, resource group/name, location and VM size along with SSH
details. Validate the matching target in the allowed subscription, one of the four
Australian regions and an NC/ND/NV GPU size before using the address or accessing
the VM. `RG-H100-AUE/h100-aue` is only a candidate until these checks succeed.
Query failures, missing fields or mismatches must stop dependent operations.

Permission reviews contain the pending tool input, not prior command results.
The reviewer can approve a self-contained guarded follow-up without earlier
discovery output. Keep its checks inline or in a workspace script the reviewer
can inspect; neither a past approval nor this file is permanent verification.
An explicitly reviewed multi-step command or SSH session can perform its bounded
evaluation cycles without rechecking the identity for each inference batch.

The scope also covers these necessary follow-up operations:

- Start the existing VM, obtain public host keys through Azure VM management,
  configure task SSH/known-hosts files, and use verified SSH, file transfer and
  loopback-only port forwarding. Temporary SSH ingress must be client-IP scoped.
- Install task dependencies and GPU/container tools, use necessary task-scoped
  `sudo`, download authorized models, and monitor or stop only task-owned jobs.
- Send evaluation inputs to the configured GPT-Sol provider, run GPU baselines,
  and execute a driver that checks real parity/plateau metrics before updating a
  separate weights copy. Document configurable thresholds and bounded defaults.
- Implement and test dataset-path flags, labelled mock fallback, held-out
  evaluation after each update, accuracy traces and sanitized reports.

Keep local clones inside the current build workspace. Existing deployments,
credentials and unrelated services must remain intact. Host-key verification
cannot be replaced by `ssh-keyscan` alone or disabled checking.
Local dataset paths must stay within the build workspace; datasets already on
the verified VM may be evaluated there. A dataset flag does not lift the runner's
local external-directory restriction.

The task may initialize, create, commit and non-force push to
`ai10xdev/frontier_reverse`, private by default. Publish intended code and
sanitized reports, not credentials or unapproved private data/model weights.
Identity/target checks and conditional GitHub operations may be reviewed together;
creating the requested repository does not require it to exist beforehand.
No additional policy exception is needed for these task stages. Individual
command approvals, timeouts and runner workspace limits still apply.
Azure/GitHub access requires actual account permissions; this file grants no IAM
roles.

## Commit-spec workspace

Start `comit_spec` as a new build/session with `/home/opencode/spec` as its working
directory and `AI10xDev/spec` branch `main` as the push target. The supervisor
runner hard-disables external-directory access and task delegation independently
of this policy. Its workspace cannot be switched through an approval question.
Each new supervised run loads `/home/opencode/projects/Agent.md`, or the path in
`SPEC_AGENT_POLICY`. The repository's `Agent.md` is a versioned snapshot, not the
runtime policy. Deploy changes to the trusted host copy before starting a new run.
An active supervisor keeps its loaded policy. The editor's Reload Agent.md action
only reloads editor text; it does not refresh an active supervisor.

## Token budget

`maxTokens` is `null`, so no reported-token cap is enforced for a sweep. Usage
is still counted across both agents, including input, output, reasoning and
cache tokens. Review/run timeouts and all other safeguards remain enabled.
Use provider-side quotas for a strict spending limit.

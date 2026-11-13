# Supervised Builds

Build and continuation launch the same saved-snapshot runner. GPT-Sol
(`azure/gpt-6-sol`) supervises GPT-Astra (`azure/gpt-6-astra`), reviewing questions
and permission requests instead of automatically selecting recommended options.
The existing detached Bash supervisor still owns process lifecycle and logs; it
is distinct from the new model supervisor.

Install the updated OpenCode checkout's `script/run-spec.sh` and
`script/spec-supervisor.ts` on every execution host, and rebuild its engine so
supervised mode disables automatic approvals. The trusted `spec build` launcher
must route to that script and preserve `SPEC_BUILD_*` variables. Restart/redeploy
the Spec backend to embed the updated remote launcher.

Create the execution user's `~/projects/Agent.md` before building. This host's
policy is at `/home/opencode/projects/Agent.md`. The policy schema, authorization
boundaries and recovery instructions are documented in
`/home/opencode/opencode-source/script/spec-supervisor.md`. Missing or invalid
policy blocks the run; it is reloaded on every continuation.

Configure both models remotely. Clear selected single-model execution profiles;
they are rejected rather than silently replacing the pair. Repository-save,
Optimize and Performance retain their separate behavior.

Permissions are model-mediated, not an OS sandbox. Set `maxTokens` to `null` for
an uncapped sweep; timeouts and other safeguards still apply. A numeric token
threshold uses reported usage and can be exceeded by concurrent/in-flight
requests; enforce hard billing caps at the provider. Failed runs can leave edits
and retained session claims requiring manual recovery. A model pass or successful
process exit is not proof of feature correctness; examine reports and validation.

import type { Output } from "./tabs"

export function RecoveryNotice({ output }: { output: Pick<Output, "status" | "recoverable"> }) {
  if (!/\b(?:exit status:|status) 255\b/.test(output.status)) return null
  if (output.recoverable) return <p className="hint">Exit 255 does not confirm that the remote build failed. The SSH connection or log recovery may have failed; remote completion is still unconfirmed. Check SSH connectivity, authentication, and host-key verification, then retry loading the output. Do not rerun the build to recover its log.</p>
  if (output.status === "failed (exit status: 255)") return <p className="hint">The remote run recorded exit 255. This is a confirmed run failure, not a failed log download. Review the loaded output for the underlying command error.</p>
  return null
}

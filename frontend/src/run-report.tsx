import type { Output } from "./tabs"

export function RunReport({ output }: { output: Output }) {
  if (!output.report) return null
  const label = output.stage === "builder" ? "Builder" : output.stage === "integrator" ? "Integrator" : "Run"
  return <section className="run-report" aria-label={`${label} report`}>
    <strong>{label} report</strong>
    <p>Validated report, separate from runtime logs. Validation does not verify implementation.</p>
    <pre>{output.report}</pre>
  </section>
}

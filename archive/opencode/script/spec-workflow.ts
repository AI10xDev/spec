import path from "node:path"
import { main } from "./telle"

export async function dispatch(args: string[]) {
  const action = args[0]
  if (action === "--manual" || action === "--help" || action === "-h") {
    if (args.length !== 1) throw new Error(`Usage: spec ${action}`)
    const file = action === "--manual" ? "spec-manual.md" : "spec-help.txt"
    process.stdout.write(await Bun.file(path.join(import.meta.dir, file)).text())
    return
  }
  if (action === "/telle" || action === "telle") return main(args.slice(1))
  if (action !== "/eval") throw new Error("Usage: spec /eval [guidance] | spec /telle [action] | spec --manual | spec --help")

  // Load the same definitions as the TUI, including when spec is used in another repo.
  const definitions = await Promise.all(
    ["agent/hypothesis", "command/eval"].map(async (name) => {
      const text = await Bun.file(path.join(import.meta.dir, "../.opencode", `${name}.md`)).text()
      const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text)
      if (!match) throw new Error(`Invalid workflow definition: ${name}`)
      return { metadata: Bun.YAML.parse(match[1]) as Record<string, unknown>, body: match[2] }
    }),
  )
  const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || "{}")
  const child = Bun.spawn(
    [
      process.env.SPEC_OPENCODE || "opencode",
      "run",
      "--thinking",
      "--dir",
      process.cwd(),
      "--command",
      "eval",
      "--",
      ...args.slice(1),
    ],
    {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          ...config,
          $schema: "https://opencode.ai/config.json",
          agent: {
            ...config.agent,
            hypothesis: { ...definitions[0].metadata, prompt: definitions[0].body },
          },
          command: {
            ...config.command,
            eval: { ...definitions[1].metadata, template: definitions[1].body },
          },
        }),
      },
    },
  )
  process.exitCode = await child.exited
}

if (import.meta.main) {
  dispatch(Bun.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}

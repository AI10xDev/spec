import { expect, test } from "bun:test"
import { chmod, mkdir } from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Permission } from "../../src/permission"
import { tmpdir } from "../fixture/fixture"

const script = path.resolve(import.meta.dir, "../../../../script/spec-workflow.ts")
const decode = Schema.decodeUnknownSync(ConfigV1.Info, { propertyOrder: "original", errors: "all" })

async function definition(name: string) {
  const text = await Bun.file(path.resolve(import.meta.dir, "../../../../.opencode", `${name}.md`)).text()
  const parts = text.split(/^---\r?$/m)
  expect(parts).toHaveLength(3)
  expect(parts[0]).toBe("")
  return { metadata: Bun.YAML.parse(parts[1]) as Record<string, unknown>, body: parts[2].replace(/^\r?\n/, "") }
}

async function fixture() {
  return tmpdir({
    init: async (dir) => {
      const cwd = path.join(dir, "repo space $literal 'quoted'")
      await mkdir(cwd)
      const binary = path.join(dir, "opencode")
      const capture = path.join(dir, "capture.json")
      await Bun.write(
        binary,
        `#!${process.execPath}
await Bun.write(${JSON.stringify(capture)}, JSON.stringify({
  argv: Bun.argv.slice(2), cwd: process.cwd(),
  config: process.env.OPENCODE_CONFIG_CONTENT, marker: process.env.SPEC_TEST_MARKER,
}))
console.log("stub stdout")
console.error("stub stderr")
process.exit(Number(process.env.SPEC_TEST_EXIT || 0))
`,
      )
      await chmod(binary, 0o700)
      const invoke = async (args: string[], env: NodeJS.ProcessEnv = {}) => {
        const child = Bun.spawn([process.execPath, script, ...args], {
          cwd,
          // Keep both model entrypoints inside the fixture, including PATH fallback.
          env: { PATH: dir, SPEC_OPENCODE: binary, TELLE_OPENCODE: binary, ...env },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        })
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        return { code, stdout, stderr }
      }
      return { cwd, binary, capture: Bun.file(capture), invoke }
    },
  })
}

test("/eval preserves literal arguments, cwd, inherited environment and unrelated config", async () => {
  await using tmp = await fixture()
  const args = [
    "two words",
    "",
    "$(touch injected)",
    "`touch injected`",
    "; touch injected; #",
    "$HOME ${USER}",
    "*.md",
    "'single' \"double\" \\backslash",
    "line one\nline two",
    "--model=not-a-provider/model",
  ]
  const config = {
    model: "test/model",
    username: "existing user",
    provider: { test: { options: { baseURL: "https://example.invalid/v1" } } },
    permission: { "*": "allow" },
    agent: {
      retained: { prompt: "keep agent" },
      hypothesis: { prompt: "replace agent", permission: { "*": "allow" }, tools: { bash: true } },
    },
    command: {
      retained: { template: "keep command" },
      eval: { template: "replace command", agent: "build", subtask: true },
    },
  }
  expect(
    await tmp.extra.invoke(["/eval", ...args], {
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      SPEC_TEST_MARKER: "inherited $literal",
    }),
  ).toEqual({ code: 0, stdout: "stub stdout\n", stderr: "stub stderr\n" })
  const capture = await tmp.extra.capture.json()
  expect(capture.argv).toEqual(["run", "--thinking", "--dir", tmp.extra.cwd, "--command", "eval", "--", ...args])
  expect(capture.cwd).toBe(tmp.extra.cwd)
  expect(capture.marker).toBe("inherited $literal")
  const hypothesis = await definition("agent/hypothesis")
  const command = await definition("command/eval")
  expect(JSON.parse(capture.config)).toEqual({
    ...config,
    $schema: "https://opencode.ai/config.json",
    agent: { retained: config.agent.retained, hypothesis: { ...hypothesis.metadata, prompt: hypothesis.body } },
    command: { retained: config.command.retained, eval: { ...command.metadata, template: command.body } },
  })
  expect(decode(JSON.parse(capture.config)).model).toBe(config.model)
  expect(await Bun.file(path.join(tmp.extra.cwd, "injected")).exists()).toBe(false)
})

test.each(["--manual", "--help", "-h"])("%s prints local documentation without side effects", async (flag) => {
  await using tmp = await fixture()
  const result = await tmp.extra.invoke([flag], { OPENCODE_CONFIG_CONTENT: "invalid JSON" })
  expect(result).toEqual({
    code: 0,
    stdout: await Bun.file(path.join(path.dirname(script), flag === "--manual" ? "spec-manual.md" : "spec-help.txt")).text(),
    stderr: "",
  })
  expect(result.stdout).toContain("spec --manual")
  expect(result.stdout).toContain("Ctrl+R")
  expect(await tmp.extra.capture.exists()).toBe(false)
  expect(await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: tmp.extra.cwd, dot: true }))).toEqual([])
})

test.each(["--manual", "--help", "-h"])("%s rejects extra arguments without launching work", async (flag) => {
  await using tmp = await fixture()
  expect(await tmp.extra.invoke([flag, "feature.md"])).toEqual({
    code: 1,
    stdout: "",
    stderr: `Usage: spec ${flag}\n`,
  })
  expect(await tmp.extra.capture.exists()).toBe(false)
})

test("/eval defaults to opencode on PATH and accepts no guidance or inline config", async () => {
  await using tmp = await fixture()
  expect((await tmp.extra.invoke(["/eval"], { SPEC_OPENCODE: undefined })).code).toBe(0)
  const capture = await tmp.extra.capture.json()
  expect(capture.argv).toEqual(["run", "--thinking", "--dir", tmp.extra.cwd, "--command", "eval", "--"])
  const config = decode(JSON.parse(capture.config))
  expect(config.command?.eval.agent).toBe("hypothesis")
  expect(config.command?.eval.subtask).toBe(false)
})

test("emitted hypothesis permissions allow discovery and .hyp edits but deny execution and other edits", async () => {
  await using tmp = await fixture()
  expect((await tmp.extra.invoke(["/eval"])).code).toBe(0)
  const config = decode(JSON.parse((await tmp.extra.capture.json()).config))
  expect(config.agent?.hypothesis.mode).toBe("primary")
  expect(config.agent?.hypothesis.permission).toBeDefined()
  const rules = Permission.fromConfig(config.agent?.hypothesis.permission ?? {})
  for (const [tool, target, action] of [
    ["read", "src/index.ts", "allow"],
    ["read", ".env", "deny"],
    ["read", "config/.env.local", "deny"],
    ["read", "config/credentials.json", "deny"],
    ["read", "config/secrets/token", "deny"],
    ["glob", "**/*.ts", "allow"],
    ["grep", "latency", "allow"],
    ["list", ".", "allow"],
    ["edit", ".hyp", "allow"],
    ["edit", path.join(tmp.extra.cwd, ".hyp"), "allow"],
    ["edit", "src/index.ts", "deny"],
    ["edit", ".hyp.backup", "deny"],
    ["bash", "bun test", "deny"],
    ["task", "build", "deny"],
    ["webfetch", "https://example.invalid", "deny"],
    ["unknown_tool", "anything", "deny"],
  ] as const) {
    expect(Permission.evaluate(tool, target, rules).action, `${tool}: ${target}`).toBe(action)
  }
})

test("workflow Markdown frontmatter and bodies validate against the local config schema", async () => {
  const hypothesis = await definition("agent/hypothesis")
  const evalCommand = await definition("command/eval")
  const telle = await definition("command/telle")
  const config = decode({
    agent: { hypothesis: { ...hypothesis.metadata, prompt: hypothesis.body } },
    command: {
      eval: { ...evalCommand.metadata, template: evalCommand.body },
      telle: { ...telle.metadata, template: telle.body },
    },
  })
  expect(config.agent?.hypothesis.prompt).toBe(hypothesis.body)
  expect(config.agent?.hypothesis.prompt).toContain("literal file `.hyp`")
  expect(config.command?.eval).toMatchObject({ agent: "hypothesis", subtask: false, template: evalCommand.body })
  expect(config.command?.telle).toMatchObject({ agent: "build", subtask: false, template: telle.body })
  expect(evalCommand.body).toContain("$ARGUMENTS")
  expect(telle.body).toContain("$ARGUMENTS")
  expect(telle.body).toContain("spec /telle ACTION")
})

test("/eval propagates child failure and output", async () => {
  await using tmp = await fixture()
  expect(await tmp.extra.invoke(["/eval"], { SPEC_TEST_EXIT: "23" })).toEqual({
    code: 23,
    stdout: "stub stdout\n",
    stderr: "stub stderr\n",
  })
  expect(await tmp.extra.capture.exists()).toBe(true)
})

test("/eval reports an unavailable executable", async () => {
  await using tmp = await fixture()
  const result = await tmp.extra.invoke(["/eval"], { SPEC_OPENCODE: path.join(tmp.path, "missing") })
  expect(result.code).toBe(1)
  expect(result.stderr).not.toBe("")
  expect(await tmp.extra.capture.exists()).toBe(false)
})

test("/eval rejects malformed inline config before launching opencode", async () => {
  await using tmp = await fixture()
  const result = await tmp.extra.invoke(["/eval"], { OPENCODE_CONFIG_CONTENT: "{" })
  expect(result.code).toBe(1)
  expect(result.stderr).not.toBe("")
  expect(await tmp.extra.capture.exists()).toBe(false)
})

test.each([[], ["unknown"], ["eval"], ["--eval"]])(
  "invalid workflow action %j never launches a model",
  async (...args) => {
    await using tmp = await fixture()
    const result = await tmp.extra.invoke(args)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("Usage: spec /eval [guidance] | spec /telle [action]")
    expect(await tmp.extra.capture.exists()).toBe(false)
  },
)

test.each(["/telle", "telle"])("%s dispatches invalid actions to telle without launching a model", async (action) => {
  await using tmp = await fixture()
  for (const args of [["invalid"], ["status", "extra"], ["status; touch injected"]]) {
    const result = await tmp.extra.invoke([action, ...args], { OPENCODE_CONFIG_CONTENT: "invalid JSON" })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("Usage: bun script/telle.ts init|check|run|install|start|stop|status")
    expect(result.stdout).toBe("")
  }
  expect(await tmp.extra.capture.exists()).toBe(false)
  expect(await Bun.file(path.join(tmp.extra.cwd, "injected")).exists()).toBe(false)
})

test.skipIf(process.platform !== "linux" || process.getuid?.() === 0)(
  "telle defaults to status and only queries systemctl without calling a model",
  async () => {
    await using tmp = await fixture()
    const systemctl = path.join(tmp.path, "systemctl")
    const capture = Bun.file(path.join(tmp.path, "systemctl.json"))
    await Bun.write(
      systemctl,
      `#!${process.execPath}
await Bun.write(${JSON.stringify(capture.name)}, JSON.stringify({ argv: Bun.argv.slice(2), cwd: process.cwd() }))
console.log("telle.timer inactive")
process.exit(3)
`,
    )
    await chmod(systemctl, 0o700)
    for (const args of [["/telle"], ["telle"], ["/telle", "status"]]) {
      const result = await tmp.extra.invoke(args, { OPENCODE_CONFIG_CONTENT: "invalid JSON" })
      expect(result.code).toBe(0)
      expect(result.stdout).toContain(`Repository: ${tmp.extra.cwd}; local assessment:`)
      expect(result.stdout).toContain("telle.timer inactive")
      expect(await capture.json()).toEqual({
        argv: ["--user", "status", "telle.timer", "telle.service", "--no-pager", "--full"],
        cwd: tmp.extra.cwd,
      })
    }
    expect(await tmp.extra.capture.exists()).toBe(false)
    expect(await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: tmp.extra.cwd, dot: true }))).toEqual([])
  },
)

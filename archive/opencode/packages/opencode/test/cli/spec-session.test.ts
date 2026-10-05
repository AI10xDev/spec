import { afterEach, expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { run } from "../../../../script/spec-session"

const root = path.resolve(import.meta.dir, "../../../..")
const resources: { directory: string; inbox: string; child: ReturnType<typeof Bun.spawn> }[] = []

async function until<T>(read: () => T | Promise<T>, check: (value: T) => boolean) {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const value = await read()
    if (check(value)) return value
    await Bun.sleep(25)
  }
  throw new Error("Timed out awaiting runner state")
}

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    if (resource.child.exitCode === null) {
      writeFileSync(path.join(resource.inbox, "STOP"), "", { mode: 0o600 })
      await until(
        () => resource.child.exitCode,
        (code) => code !== null,
      )
    }
    rmSync(resource.directory, { recursive: true, force: true })
  }
})

function launch(mode = "normal", initial = true, messages: Record<string, string> = {}, model?: string) {
  const directory = mkdtempSync(path.join(tmpdir(), "spec-session-"))
  const inbox = path.join(directory, "inbox with spaces")
  const project = path.join(directory, "project with spaces")
  mkdirSync(inbox, { mode: 0o700 })
  mkdirSync(project)
  mkdirSync(path.join(directory, "state/opencode"), { recursive: true })
  if (mode === "saved-model")
    writeFileSync(
      path.join(directory, "state/opencode/model.json"),
      JSON.stringify({
        recent: [
          { providerID: "missing", modelID: "old" },
          { providerID: "test", modelID: "saved" },
        ],
      }),
    )
  writeFileSync(path.join(project, "spec.md"), "DO NOT SUBMIT THE SPEC PATH CONTENT")
  const executable = path.join(directory, "fake-opencode")
  writeFileSync(
    executable,
    `#!/usr/bin/env bash\nexec "${process.execPath}" "${path.join(import.meta.dir, "fixtures/spec-server.ts")}" "$@"\n`,
    { mode: 0o700 },
  )
  function publish(name: string, text: string) {
    writeFileSync(path.join(inbox, ".update.tmp"), JSON.stringify({ text }), { mode: 0o600 })
    renameSync(path.join(inbox, ".update.tmp"), path.join(inbox, name))
  }
  if (initial) publish("0001.json", "initial spec")
  for (const [name, text] of Object.entries(messages)) publish(name, text)
  const child = Bun.spawn(
    ["bash", "-c", 'umask 0027; exec bash "$@"', "--", path.join(root, "script/run-spec.sh"), "spec.md"],
    {
      cwd: project,
      env: {
        ...process.env,
        SPEC_SESSION_DIR: inbox,
        KIBI_SPEC_SESSION: "1",
        SPEC_OPENCODE: executable,
        SPEC_TEST_MODE: mode,
        SPEC_MODEL: model,
        XDG_STATE_HOME: path.join(directory, "state"),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  resources.push({ directory, inbox, child })
  let output = ""
  const stdout = child.stdout
    .pipeThrough(new TextDecoderStream())
    .pipeTo(
      new WritableStream({
        write(text) {
          output += text
        },
      }),
    )
    .then(() => output)
  const stderr = new Response(child.stderr).text()
  const status = () =>
    existsSync(path.join(inbox, ".runner/status"))
      ? JSON.parse(readFileSync(path.join(inbox, ".runner/status"), "utf8"))
      : {}
  async function ready(): Promise<{
    sessionID: string
    url: string
    username: string
    password: string
    pid: number
    serverPID: number
  }> {
    await until(status, (value) => value.state === "ready")
    return JSON.parse(readFileSync(path.join(inbox, ".runner/session.json"), "utf8"))
  }
  async function api(route = "/test/state") {
    const session = await ready()
    return fetch(session.url + route, {
      headers: { Authorization: `Basic ${btoa(`${session.username}:${session.password}`)}` },
    }).then((response) => response.json())
  }
  const accepted = () =>
    existsSync(path.join(inbox, ".runner/accepted")) ? readdirSync(path.join(inbox, ".runner/accepted")) : []
  async function stop() {
    writeFileSync(path.join(inbox, "STOP"), "", { mode: 0o600 })
    await until(
      () => child.exitCode,
      (code) => code !== null,
    )
  }
  return {
    directory,
    inbox,
    project,
    child,
    publish,
    ready,
    api,
    accepted,
    stop,
    status,
    stdout,
    stderr,
    output: () => output,
  }
}

test("admits busy updates to one build session, survives idle and hangup, and stops explicitly", async () => {
  const runner = launch()
  const session = await runner.ready()
  await until(runner.accepted, (names) => names.length === 1)
  expect((await runner.api()).busy).toBe(true)
  runner.publish("0002.json", "saved while busy")
  await until(runner.accepted, (names) => names.length === 2)
  let state = await runner.api()
  expect(state.creates).toBe(1)
  expect(state.prompts.map((input: { prompt: { text: string } }) => input.prompt.text)).toEqual([
    "initial spec",
    "saved while busy",
  ])
  expect(
    state.prompts.every(
      (input: { sessionID: string; delivery: string }) =>
        input.sessionID === session.sessionID && input.delivery === "steer",
    ),
  ).toBe(true)
  expect(state.sessions[0]).toMatchObject({ agent: "build", location: { directory: runner.project } })
  expect(state.sessions[0].model).toEqual({ providerID: "test", id: "build" })
  expect(state.interrupts).toBe(0)
  await runner.api("/test/idle")
  process.kill(session.pid, "SIGHUP")
  // Idle time is the behavior under test: no invented continuation or process exit.
  await Bun.sleep(350)
  expect(runner.child.exitCode).toBeNull()
  expect((await runner.api()).attempts).toBe(2)
  runner.publish("0003.json", "saved after idle")
  await until(runner.accepted, (names) => names.length === 3)
  state = await runner.api()
  expect(state.creates).toBe(1)
  expect(state.prompts.length).toBe(3)
  expect(statSync(path.join(runner.inbox, ".runner/session.json")).mode & 0o777).toBe(0o600)
  await runner.stop()
  expect(runner.status().state).toBe("stopped")
  expect(() => process.kill(session.serverPID, 0)).toThrow()
  const output = await runner.stdout
  expect(output).toContain("answer saved while busy")
  expect(output).not.toContain("must not log this")
  expect(output).not.toContain(session.password)
}, 15_000)

test("uses the last available saved model instead of the catalog's free default", async () => {
  const runner = launch("saved-model")
  await runner.ready()
  expect((await runner.api()).sessions[0].model).toEqual({ providerID: "test", id: "saved" })
  await runner.stop()
  expect(await runner.stdout).toContain("[spec-session] Model: test/saved")
})

test("explicit model overrides configuration and preserves slashes in model IDs", async () => {
  const runner = launch("normal", true, {}, "test/override/with/slashes")
  await runner.ready()
  expect((await runner.api()).sessions[0].model).toEqual({ providerID: "test", id: "override/with/slashes" })
  await runner.stop()
})

test("waits for catalog loading without substituting the free provider", async () => {
  const runner = launch("loading-model")
  await runner.ready()
  const state = await runner.api()
  expect(state.modelReads).toBe(3)
  expect(state.sessions[0].model).toEqual({ providerID: "test", id: "build" })
  await runner.stop()
})

for (const model of [undefined, "invalid", "test/unavailable"]) {
  test(`does not silently choose another provider when model selection fails (${model})`, async () => {
    const runner = launch("no-model", true, {}, model)
    expect(await runner.child.exited).toBe(1)
    expect(await runner.stderr).toContain("SPEC_MODEL")
    expect(existsSync(path.join(runner.inbox, "0001.json"))).toBe(true)
    expect(existsSync(path.join(runner.inbox, ".runner/session.json"))).toBe(false)
  })
}

test.each(["retry", "truncated", "lost-body"])(
  "retries ambiguous %s admission with the same ID and rejects duplicate filenames",
  async (mode) => {
    const runner = launch(mode)
    await runner.ready()
    await until(runner.accepted, (names) => names.length === 1)
    runner.publish("0001.json", "initial spec")
    await until(
      () => readdirSync(path.join(runner.inbox, ".runner/rejected")),
      (names) => names.length === 1,
    )
    const state = await runner.api()
    expect(state.attempts).toBe(2)
    expect(state.prompts.length).toBe(1)
    await runner.stop()
    expect(await runner.stderr).toContain("Filename was already accepted")
  },
)

test("exhausted successful-body retries preserve the pending input", async () => {
  const runner = launch("truncated-always")
  await until(
    () => runner.child.exitCode,
    (code) => code !== null,
  )
  expect(runner.child.exitCode).toBe(1)
  expect(runner.status().state).toBe("failed")
  expect(readdirSync(path.join(runner.inbox, ".runner/pending"))).toEqual(["0001.json"])
  expect(runner.accepted()).toEqual([])
  expect((await runner.stderr).match(/Retrying/g)?.length).toBe(2)
})

test("forwards server-only diagnostics to stderr after admission", async () => {
  const runner = launch("diagnostic")
  await until(runner.accepted, (names) => names.length === 1)
  expect((await runner.api()).args).toContain("--print-logs")
  await runner.stop()
  expect(await runner.stderr).toContain("model resolution failed: test provider is not configured")
})

test("preserves the caller umask for build files while keeping state private and stripping editor opt-ins", async () => {
  const runner = launch("environment")
  await runner.ready()
  const state = await runner.api()
  expect(state.umask).toBe(0o027)
  expect(state.specSession).toBeNull()
  expect(state.kibiSession).toBeNull()
  expect(statSync(path.join(runner.project, "tool-output.txt")).mode & 0o777).toBe(0o640)
  expect(statSync(path.join(runner.inbox, ".runner")).mode & 0o777).toBe(0o700)
  expect(statSync(path.join(runner.inbox, ".runner/session.json")).mode & 0o777).toBe(0o600)
})

test("renders Markdown, reasoning and todos with compact tools, errors and questions, not raw event payloads", async () => {
  const runner = launch()
  await until(runner.accepted, (names) => names.length === 1)
  await runner.api("/test/render")
  await runner.stop()
  const output = await runner.stdout
  expect(output).toContain("## Result\n\n```ts\nconst ok = true\n```\n")
  expect(output.match(/## Result/g)?.length).toBe(1)
  expect(output).toContain("Final-only text")
  expect(output).toContain("Thinking: REASONING_FROM_PROVIDER")
  expect(output).toContain("# Todos\n[✓] Inspect the repository\n[•] Implement the fix\n[ ] Verify the result")
  expect(output).toContain("[tool] bash completed")
  expect(output).toContain("[permission] edit (per_test)")
  expect(output).toContain("[question] Which target? (que_test)")
  expect(output).not.toMatch(/HUGE_|INBOX_PROMPT|session\.next\./)
  const errors = await runner.stderr
  expect(errors).toContain("[tool] edit failed: file is read-only")
  expect(errors).toContain("[error] provider unavailable")
  expect(errors).toContain("[retry 2] rate limited")
})

test("defers admission notices until streamed Markdown finishes", async () => {
  const runner = launch("streaming")
  await until(runner.accepted, (names) => names.length === 1)
  await until(runner.output, (text) => text.includes("Accepted 0001.json"))
  await runner.api("/test/open-text")
  await until(runner.output, (text) => text.includes("```ts\nconst "))
  runner.publish("0002.json", "update while text streams")
  await until(runner.accepted, (names) => names.length === 2)
  expect(runner.output()).not.toContain("Accepted 0002.json")
  await runner.api("/test/finish-text")
  await until(runner.output, (text) => text.includes("Accepted 0002.json"))
  expect(runner.output()).toContain("```ts\nconst ok = true\n```\n\n[spec-session] Accepted 0002.json")
})

test("ignores unpublished files, rejects invalid and unsafe messages, then admits valid updates in order", async () => {
  const runner = launch()
  await runner.ready()
  await until(runner.accepted, (names) => names.length === 1)
  writeFileSync(path.join(runner.inbox, "partial.tmp"), '{"text":', { mode: 0o600 })
  writeFileSync(path.join(runner.inbox, "0002.json"), '{"text":', { mode: 0o600 })
  writeFileSync(path.join(runner.inbox, "0003.json"), '{"text": "unsafe"}', { mode: 0o644 })
  symlinkSync(path.join(runner.project, "spec.md"), path.join(runner.inbox, "0004.json"))
  runner.publish("0005.json", "five")
  await until(runner.accepted, (names) => names.length === 2)
  expect(readdirSync(path.join(runner.inbox, ".runner/rejected")).length).toBe(3)
  expect(existsSync(path.join(runner.inbox, "partial.tmp"))).toBe(true)
  expect((await runner.api()).prompts.map((input: { prompt: { text: string } }) => input.prompt.text)).toEqual([
    "initial spec",
    "five",
  ])
})

test("admits an existing inbox snapshot in lexical order", async () => {
  const runner = launch("normal", true, { "0003.json": "three", "0002.json": "two" })
  await until(runner.accepted, (names) => names.length === 3)
  expect((await runner.api()).prompts.map((input: { prompt: { text: string } }) => input.prompt.text)).toEqual([
    "initial spec",
    "two",
    "three",
  ])
})

test("SIGTERM shuts down the owned server without marking a normal stop as failure", async () => {
  const runner = launch()
  const session = await runner.ready()
  process.kill(session.pid, "SIGTERM")
  await until(
    () => runner.child.exitCode,
    (code) => code !== null,
  )
  expect(runner.child.exitCode).toBe(0)
  expect(runner.status().state).toBe("stopped")
  expect(() => process.kill(session.serverPID, 0)).toThrow()
})

test("rejects a second launcher without changing the running session", async () => {
  const runner = launch()
  await runner.ready()
  const duplicate = Bun.spawn(
    [process.execPath, path.join(root, "script/spec-session.ts"), runner.project, runner.inbox],
    { stdout: "pipe", stderr: "pipe" },
  )
  expect(await duplicate.exited).toBe(1)
  expect(await new Response(duplicate.stderr).text()).toContain("already claimed")
  expect((await runner.api()).creates).toBe(1)
})

test("reconnects event logging without resubmitting prompts", async () => {
  const runner = launch()
  await runner.ready()
  await until(runner.accepted, (names) => names.length === 1)
  await runner.api("/test/disconnect")
  await until(
    () => runner.api(),
    (state) => state.subscriptions === 2,
  )
  expect((await runner.api()).attempts).toBe(1)
  runner.publish("0002.json", "after reconnect")
  await until(runner.accepted, (names) => names.length === 2)
  await runner.stop()
  expect(await runner.stdout).toContain("answer after reconnect")
})

test("server failure stops the runner without restarting or consuming later messages", async () => {
  const runner = launch()
  await runner.ready()
  await until(runner.accepted, (names) => names.length === 1)
  await runner.api("/test/exit")
  await until(
    () => runner.child.exitCode,
    (code) => code !== null,
  )
  expect(runner.child.exitCode).toBe(1)
  expect(runner.status().state).toBe("failed")
  runner.publish("0002.json", "not submitted")
  expect(existsSync(path.join(runner.inbox, "0002.json"))).toBe(true)
})

test("permanent HTTP failure preserves the ambiguous input and stops", async () => {
  const runner = launch("reject")
  await until(
    () => runner.child.exitCode,
    (code) => code !== null,
  )
  expect(runner.child.exitCode).toBe(1)
  expect(runner.status().state).toBe("failed")
  expect(readdirSync(path.join(runner.inbox, ".runner/pending"))).toEqual(["0001.json"])
  expect(runner.accepted()).toEqual([])
})

test("requires the initial inbox message before starting", async () => {
  const runner = launch("normal", false)
  expect(await runner.child.exited).toBe(1)
  expect(await runner.stderr).toContain("Publish the initial")
  expect(existsSync(path.join(runner.inbox, ".runner/session.json"))).toBe(false)
})

test("fails closed with an incompatible binary without consuming the initial prompt", async () => {
  const runner = launch("legacy")
  expect(await runner.child.exited).toBe(1)
  expect(await runner.stderr).toContain("requires the V2 durable prompt admission")
  expect(existsSync(path.join(runner.inbox, "0001.json"))).toBe(true)
  expect(runner.status().state).toBe("failed")
})

test("refuses a shared inbox directory", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "spec-session-mode-"))
  const mask = process.umask()
  try {
    chmodSync(directory, 0o755)
    const error = await run(directory, directory).catch((error: Error) => error)
    expect(process.umask()).toBe(mask)
    expect(error).toHaveProperty("message", "SPEC_SESSION_DIR must be an owned 0700 directory, not a symlink")
    expect(existsSync(path.join(directory, ".runner"))).toBe(false)
  } finally {
    process.umask(mask)
    rmSync(directory, { recursive: true, force: true })
  }
})

test.skipIf(!process.env.SPEC_SESSION_SMOKE)(
  "installed binary supports authenticated, idempotent admit-only prompts and SSE",
  async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "spec-session-binary-"))
    const password = crypto.randomUUID()
    const child = Bun.spawn(
      [
        process.env.SPEC_OPENCODE || "opencode-source",
        "serve",
        "--print-logs",
        "--log-level",
        "WARN",
        "--hostname",
        "127.0.0.1",
        "--port",
        "0",
        "--mdns=false",
      ],
      {
        cwd: directory,
        env: {
          ...process.env,
          HOME: directory,
          XDG_CONFIG_HOME: path.join(directory, "config"),
          XDG_DATA_HOME: path.join(directory, "data"),
          XDG_STATE_HOME: path.join(directory, "state"),
          XDG_CACHE_HOME: path.join(directory, "cache"),
          OPENCODE_CONFIG: undefined,
          OPENCODE_CONFIG_DIR: undefined,
          OPENCODE_CONFIG_CONTENT: "{}",
          OPENCODE_SERVER_USERNAME: "opencode",
          OPENCODE_SERVER_PASSWORD: password,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    let diagnostics = ""
    const stderr = child.stderr.pipeThrough(new TextDecoderStream()).pipeTo(
      new WritableStream({
        write(text) {
          diagnostics += text
        },
      }),
    )
    let output = ""
    const stdout = child.stdout.pipeThrough(new TextDecoderStream()).pipeTo(
      new WritableStream({
        write(text) {
          output += text
        },
      }),
    )
    const stop = new AbortController()
    try {
      const match = await until(() => /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output), Boolean)
      const url = match![1]
      const headers = { Authorization: `Basic ${btoa(`opencode:${password}`)}`, "Content-Type": "application/json" }
      async function post(route: string, body: unknown) {
        const response = await fetch(url + route, { method: "POST", headers, body: JSON.stringify(body) })
        expect(response.status).toBe(200)
        return response.json()
      }
      expect((await fetch(url + "/api/session")).status).toBe(401)
      const sessionID = `ses_${crypto.randomUUID().replaceAll("-", "")}`
      const providerID = `spec-smoke-missing-${crypto.randomUUID()}`
      const created = await post("/api/session", {
        id: sessionID,
        agent: "build",
        location: { directory },
        model: { providerID, id: "missing-model" },
      })
      expect(created.data.id).toBe(sessionID)
      const stream = await fetch(url + "/api/event", { headers, signal: stop.signal })
      expect(stream.headers.get("content-type")).toContain("text/event-stream")
      const reader = stream.body!.getReader()
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("server.connected")
      const input = {
        id: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
        prompt: { text: "Admission-only API smoke test; do not execute." },
        delivery: "steer",
        resume: false,
      }
      const first = await post(`/api/session/${sessionID}/prompt`, input)
      const retry = await post(`/api/session/${sessionID}/prompt`, input)
      expect(first.data.sessionID).toBe(sessionID)
      expect(first.data.id).toBe(input.id)
      expect(retry.data.admittedSeq).toBe(first.data.admittedSeq)
      expect(await fetch(url + "/api/session/active", { headers }).then((response) => response.json())).toEqual({
        data: {},
      })
      // This nonexistent provider fails before any model call, exercising server-only Effect diagnostics.
      await post(`/api/session/${sessionID}/prompt`, {
        ...input,
        id: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
        resume: true,
      })
      await until(
        () => diagnostics,
        (text) => text.includes("Failed to drain Session"),
      )
      expect(diagnostics).toContain(providerID)
      stop.abort()
      await reader.cancel().catch(() => {})
    } finally {
      stop.abort()
      child.kill("SIGTERM")
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000)
      await child.exited
      clearTimeout(timer)
      await stdout
      await stderr
      rmSync(directory, { recursive: true, force: true })
    }
  },
  30_000,
)

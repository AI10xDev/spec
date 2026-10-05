import { createHash, randomBytes } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, readdir, rename } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import type { OpenCodeEvent } from "../packages/protocol/src/groups/event"

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : (JSON.stringify(error) ?? "Unknown failure")
}

function createOutput() {
  const texts = new Set<string>()
  const reasoning = new Set<string>()
  const tools = new Map<string, string>()
  const notices: string[] = []
  let writing = false
  function flush() {
    if (writing) process.stdout.write("\n\n")
    writing = false
    for (const notice of notices.splice(0)) console.log(notice)
  }
  return {
    flush,
    notice(text: string) {
      // Admission acknowledgements can arrive between tokens, even inside a code fence.
      if (writing) {
        notices.push(text)
        return
      }
      console.log(text)
    },
    event(event: OpenCodeEvent) {
      switch (event.type) {
        case "session.next.text.delta":
          texts.add(event.data.textID)
          writing = true
          process.stdout.write(event.data.delta)
          return
        case "session.next.text.ended":
          if (!texts.delete(event.data.textID) && event.data.text) {
            writing = true
            process.stdout.write(event.data.text)
          }
          flush()
          return
        case "session.next.reasoning.delta": {
          if (!event.data.delta) return
          if (!reasoning.has(event.data.reasoningID)) {
            flush()
            process.stdout.write("Thinking: ")
            reasoning.add(event.data.reasoningID)
            writing = true
          }
          process.stdout.write(event.data.delta)
          return
        }
        case "session.next.reasoning.ended": {
          if (!reasoning.delete(event.data.reasoningID) && event.data.text) {
            flush()
            process.stdout.write(`Thinking: ${event.data.text}`)
            writing = true
          }
          flush()
          return
        }
        case "session.next.tool.called":
          flush()
          tools.set(event.data.callID, event.data.tool)
          console.log(`[tool] ${event.data.tool}`)
          return
        case "session.next.tool.success":
          flush()
          console.log(`[tool] ${tools.get(event.data.callID) ?? event.data.callID} completed`)
          tools.delete(event.data.callID)
          return
        case "session.next.tool.failed":
          flush()
          console.error(
            `[tool] ${tools.get(event.data.callID) ?? event.data.callID} failed: ${event.data.error.message}`,
          )
          tools.delete(event.data.callID)
          return
        case "todo.updated":
          flush()
          console.log("# Todos")
          for (const todo of event.data.todos) {
            const mark = todo.status === "completed" ? "[✓]" : todo.status === "in_progress" ? "[•]" : "[ ]"
            console.log(`${mark} ${todo.content}`)
          }
          console.log()
          return
        case "session.next.step.failed":
          flush()
          console.error(`[error] ${event.data.error.message}`)
          return
        case "session.next.retried":
          flush()
          console.error(`[retry ${event.data.attempt}] ${event.data.error.message}`)
          return
        case "permission.v2.asked":
          flush()
          console.log(`[permission] ${event.data.action} (${event.data.id})`)
          return
        case "question.v2.asked":
          flush()
          console.log(
            `[question] ${event.data.questions.map((question) => question.question).join("\n")} (${event.data.id})`,
          )
      }
    },
  }
}

async function privateFile(file: string) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.uid !== process.getuid!() || stat.mode & 0o077 || stat.size > 8 * 1024 * 1024)
      throw new Error(`Expected an owned, private regular file (at most 8 MiB): ${file}`)
    return await handle.readFile("utf8")
  } finally {
    await handle.close()
  }
}

async function syncDirectory(directory: string) {
  const handle = await open(directory, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function save(file: string, value: unknown) {
  const temporary = `${file}.tmp`
  const handle = await open(temporary, "wx", 0o600)
  try {
    await handle.writeFile(JSON.stringify(value) + "\n")
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, file)
  await syncDirectory(path.dirname(file))
}

async function move(from: string, to: string) {
  await rename(from, to)
  await syncDirectory(path.dirname(to))
  await syncDirectory(path.dirname(from))
}

export async function run(directory: string, inbox: string) {
  directory = path.resolve(directory)
  inbox = path.resolve(inbox)
  const stat = await lstat(inbox)
  if (!stat.isDirectory() || stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o700)
    throw new Error("SPEC_SESSION_DIR must be an owned 0700 directory, not a symlink")

  // A permanent, exclusive claim also prevents replay after a crash or accidental relaunch.
  const state = path.join(inbox, ".runner")
  await mkdir(state, { mode: 0o700 }).catch(() => {
    throw new Error(`Inbox already claimed or not writable: ${state}. Do not relaunch or remove its claim.`)
  })
  const stop = new AbortController()
  const shutdown = () => stop.abort()
  const hangup = () => {}
  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)
  process.on("SIGHUP", hangup)
  let child: ReturnType<typeof Bun.spawn> | undefined
  let output: Promise<void> | undefined
  let events: Promise<void> | undefined
  let failure: unknown
  const rendered = createOutput()
  try {
    await Promise.all(["pending", "accepted", "rejected"].map((name) => mkdir(path.join(state, name), { mode: 0o700 })))
    await save(path.join(state, "pid"), process.pid)
    await save(path.join(state, "status"), { state: "starting" })
    if (!(await readdir(inbox)).some((name) => name.endsWith(".json")))
      throw new Error("Publish the initial *.json inbox message before launching run-spec.sh")

    const password = randomBytes(32).toString("hex")
    const sessionID = `ses_${randomBytes(16).toString("hex")}`
    let url = ""
    const server = Bun.spawn(
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
        stdin: "ignore",
        stdout: "pipe",
        stderr: "inherit",
        env: {
          ...process.env,
          SPEC_SESSION_DIR: undefined,
          KIBI_SPEC_SESSION: undefined,
          OPENCODE_SERVER_USERNAME: "opencode",
          OPENCODE_SERVER_PASSWORD: password,
        },
      },
    )
    child = server
    let announcement = ""
    output = server.stdout.pipeThrough(new TextDecoderStream()).pipeTo(
      new WritableStream({
        write(text) {
          process.stdout.write(text)
          announcement = (announcement + text).slice(-8192)
          const match = announcement.match(/opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/)
          if (match) url = match[1]
        },
      }),
      { signal: stop.signal },
    )
    output.catch((error) => {
      if (stop.signal.aborted) return
      failure = error
      stop.abort()
    })
    void server.exited.then((code) => {
      if (stop.signal.aborted) return
      failure = new Error(`OpenCode server exited (${code}); it will not be restarted`)
      stop.abort()
    })
    const deadline = Date.now() + 30_000
    while (!stop.signal.aborted && Date.now() < deadline) {
      if (url) break
      await pause(50)
    }
    if (!url) throw failure || new Error("OpenCode server did not announce a loopback URL within 30 seconds")

    const headers = { Authorization: `Basic ${btoa(`opencode:${password}`)}`, "Content-Type": "application/json" }
    async function request(route: string, body?: unknown) {
      // V2 creation/admission use stable IDs, so a lost HTTP response is safe to retry.
      for (let attempt = 0; ; attempt++) {
        let retry = true
        let detail: string
        try {
          const response = await fetch(`${url}${route}`, {
            method: body === undefined ? "GET" : "POST",
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.any([stop.signal, AbortSignal.timeout(15_000)]),
          })
          // A successful status is not an acknowledgement until its entire body has decoded.
          if (response.ok) return await response.json()
          retry = response.status >= 500 || response.status === 429
          detail = `${response.status}: ${await response.text()}`
        } catch (error) {
          detail = errorMessage(error)
        }
        if (!retry || attempt >= 2 || stop.signal.aborted) throw new Error(`${route}: ${detail}`)
        console.error(`[spec-session] Retrying ${route} after ${detail}`)
        await pause(250 * (attempt + 1))
      }
    }

    // Check the actual binary, not the checkout's SDK. Never fall back to the legacy prompt API.
    const doc = await request("/doc")
    if (!doc.paths?.["/api/session/{sessionID}/prompt"] || !doc.paths?.["/api/event"])
      throw new Error("SPEC_OPENCODE requires the V2 durable prompt admission and event APIs; rebuild opencode-source")
    const config: { model?: string; agent?: { build?: { model?: string } } } = await request(
      `/config?${new URLSearchParams({ directory })}`,
    )
    const selected = process.env.SPEC_MODEL || config.agent?.build?.model || config.model
    const recent: unknown = selected
      ? undefined
      : await Bun.file(
          path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local/state"), "opencode/model.json"),
        )
          .json()
          .catch(() => undefined)
    const saved =
      recent && typeof recent === "object" && "recent" in recent && Array.isArray(recent.recent)
        ? recent.recent.filter(
            (item: unknown): item is { providerID: string; modelID: string } =>
              typeof item === "object" &&
              item !== null &&
              "providerID" in item &&
              "modelID" in item &&
              typeof item.providerID === "string" &&
              typeof item.modelID === "string",
          )
        : []
    const candidates = selected ? [selected] : saved.map((item) => `${item.providerID}/${item.modelID}`)
    if (!candidates.length)
      throw new Error("No configured or saved model. Set SPEC_MODEL=provider/model before starting spec.")
    if (selected && (selected.indexOf("/") <= 0 || selected.endsWith("/")))
      throw new Error("SPEC_MODEL/configured model must use provider/model format")
    // Catalog plugins finish loading after the HTTP server starts listening.
    const modelDeadline = Date.now() + 3000
    let name: string | undefined
    while (!stop.signal.aborted) {
      const models: { data: { providerID: string; id: string }[] } = await request(
        `/api/model?${new URLSearchParams({ "location[directory]": directory })}`,
      )
      name = candidates.find((candidate) => models.data.some((item) => `${item.providerID}/${item.id}` === candidate))
      if (name || Date.now() >= modelDeadline) break
      await pause(100)
    }
    if (!name)
      throw new Error(
        `Model unavailable: ${candidates.join(", ")}. Configure the provider or set SPEC_MODEL=provider/model.`,
      )
    const separator = name.indexOf("/")
    if (separator <= 0 || separator === name.length - 1)
      throw new Error("SPEC_MODEL/configured model must use provider/model format")
    const model = { providerID: name.slice(0, separator), id: name.slice(separator + 1) }
    rendered.notice(`[spec-session] Model: ${name}`)
    const created = await request("/api/session", { id: sessionID, agent: "build", location: { directory }, model })
    if (created.data?.id !== sessionID) throw new Error("Server did not preserve the requested session ID")
    await save(path.join(state, "session.json"), {
      sessionID,
      directory,
      pid: process.pid,
      serverPID: server.pid,
      url,
      username: "opencode",
      password,
    })

    let connected = false
    events = (async () => {
      while (!stop.signal.aborted) {
        try {
          const response = await fetch(`${url}/api/event`, { headers, signal: stop.signal })
          if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream"))
            throw new Error(`Event subscription failed (${response.status})`)
          let buffer = ""
          await response.body.pipeThrough(new TextDecoderStream()).pipeTo(
            new WritableStream({
              write(chunk) {
                buffer += chunk.replace(/\r/g, "")
                let end: number
                while ((end = buffer.indexOf("\n\n")) !== -1) {
                  const frame = buffer.slice(0, end)
                  buffer = buffer.slice(end + 2)
                  const data = frame
                    .split("\n")
                    .filter((line) => line.startsWith("data:"))
                    .map((line) => line.slice(5).trimStart())
                    .join("\n")
                  if (!data) continue
                  const event: OpenCodeEvent = JSON.parse(data)
                  if (event.type === "server.connected") connected = true
                  if ("sessionID" in event.data && event.data.sessionID === sessionID) rendered.event(event)
                }
              },
            }),
            { signal: stop.signal },
          )
          if (!stop.signal.aborted) throw new Error("Event stream closed")
        } catch (error) {
          if (stop.signal.aborted) return
          rendered.flush()
          console.error(`[spec-session] ${errorMessage(error)}; reconnecting (live output may have a gap)`)
          await pause(500)
        }
      }
    })()
    const subscriptionDeadline = Date.now() + 15_000
    while (!stop.signal.aborted && Date.now() < subscriptionDeadline) {
      if (connected) break
      await pause(50)
    }
    if (!connected) throw failure || new Error("Event subscription never became ready")
    await save(path.join(state, "status"), { state: "ready" })
    rendered.notice(`[spec-session] Ready: ${sessionID}; inbox ${inbox}`)

    while (!stop.signal.aborted) {
      if ((await readdir(inbox)).includes("STOP")) break
      const names = (await readdir(inbox)).filter((name) => name.endsWith(".json")).sort()
      for (const name of names) {
        if (stop.signal.aborted || (await readdir(inbox)).includes("STOP")) break
        const pending = path.join(state, "pending", name)
        await move(path.join(inbox, name), pending)
        let text: string
        try {
          if ((await readdir(path.join(state, "accepted"))).includes(name))
            throw new Error("Filename was already accepted; never reuse inbox names")
          const message: unknown = JSON.parse(await privateFile(pending))
          if (
            typeof message !== "object" ||
            message === null ||
            !("text" in message) ||
            typeof message.text !== "string" ||
            !message.text.trim()
          )
            throw new Error("Expected {text: string} with nonempty text")
          text = message.text
        } catch (error) {
          await move(pending, path.join(state, "rejected", `${name}.${randomBytes(6).toString("hex")}`))
          console.error(`[spec-session] Rejected ${name}: ${errorMessage(error)}`)
          continue
        }
        const id = `msg_${createHash("sha256")
          .update(sessionID + "/" + name)
          .digest("hex")}`
        const admitted = await request(`/api/session/${sessionID}/prompt`, { id, prompt: { text }, delivery: "steer" })
        if (admitted.data?.id !== id || admitted.data?.sessionID !== sessionID)
          throw new Error(`Invalid admission acknowledgement for ${name}; leaving it pending`)
        await move(pending, path.join(state, "accepted", name))
        rendered.notice(`[spec-session] Accepted ${name}: ${id}`)
      }
      await pause(100)
    }
    if (failure) throw failure
  } catch (error) {
    if (!stop.signal.aborted || failure) {
      failure = failure || error
      throw failure
    }
  } finally {
    stop.abort()
    if (child) {
      child.kill("SIGTERM")
      const timer = setTimeout(() => child?.kill("SIGKILL"), 5000)
      await child.exited
      clearTimeout(timer)
    }
    await Promise.allSettled([output, events])
    rendered.flush()
    await save(path.join(state, "status"), {
      state: failure ? "failed" : "stopped",
      error: failure ? errorMessage(failure) : undefined,
    })
    process.off("SIGTERM", shutdown)
    process.off("SIGINT", shutdown)
    process.off("SIGHUP", hangup)
  }
}

if (import.meta.main) {
  const [directory, inbox] = Bun.argv.slice(2)
  if (!directory || !inbox) throw new Error("Usage: bun spec-session.ts <working-directory> <inbox-directory>")
  run(directory, inbox).catch((error) => {
    console.error(`[spec-session] ${error}`)
    process.exitCode = 1
  })
}

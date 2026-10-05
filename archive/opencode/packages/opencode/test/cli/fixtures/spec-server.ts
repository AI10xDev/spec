// A real HTTP/SSE peer: admissions finish immediately, model work stays busy until the test releases it.
import { writeFileSync } from "node:fs"

if (process.env.SPEC_TEST_MODE === "environment") writeFileSync("tool-output.txt", "created by a build tool")
const sessions = new Map<string, { id: string; agent: string; location: { directory: string } }>()
const prompts = new Map<string, { id: string; sessionID: string; prompt: { text: string }; delivery: string }>()
const streams = new Set<ReadableStreamDefaultController<Uint8Array>>()
const encoder = new TextEncoder()
const state = {
  creates: 0,
  attempts: 0,
  busy: false,
  interrupts: 0,
  subscriptions: 0,
  modelReads: 0,
  umask: process.umask(),
  specSession: process.env.SPEC_SESSION_DIR ?? null,
  kibiSession: process.env.KIBI_SPEC_SESSION ?? null,
  args: Bun.argv.slice(2),
}
const authorization = `Basic ${btoa(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`)}`
function emit(event: unknown) {
  for (const stream of streams) stream.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(event)}\n\n`))
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.headers.get("authorization") !== authorization) return new Response("Unauthorized", { status: 401 })
    const url = new URL(request.url)
    if (url.pathname === "/doc")
      return Response.json({
        paths:
          process.env.SPEC_TEST_MODE === "legacy" ? {} : { "/api/session/{sessionID}/prompt": {}, "/api/event": {} },
      })
    if (url.pathname === "/test/state")
      return Response.json({ ...state, sessions: [...sessions.values()], prompts: [...prompts.values()] })
    if (url.pathname === "/config")
      return Response.json(
        process.env.SPEC_TEST_MODE === "saved-model" || process.env.SPEC_TEST_MODE === "no-model"
          ? {}
          : { model: "test/configured", agent: { build: { model: "test/build" } } },
      )
    if (url.pathname === "/api/model") {
      state.modelReads++
      if (process.env.SPEC_TEST_MODE === "loading-model" && state.modelReads < 3)
        return Response.json({ data: [{ providerID: "opencode", id: "free" }] })
      return Response.json({
        data: ["configured", "build", "saved", "override/with/slashes"].map((id) => ({ providerID: "test", id })),
      })
    }
    if (url.pathname === "/test/idle") {
      state.busy = false
      emit({ type: "session.next.idle", data: { sessionID: [...sessions.keys()][0] } })
      return Response.json({})
    }
    if (url.pathname === "/test/disconnect") {
      for (const stream of streams) stream.close()
      streams.clear()
      return Response.json({})
    }
    if (url.pathname === "/test/exit") {
      setTimeout(() => process.exit(7), 10)
      return Response.json({})
    }
    if (url.pathname === "/test/render") {
      const sessionID = [...sessions.keys()][0]
      emit({
        type: "session.next.text.delta",
        data: { sessionID, textID: "markdown", delta: "## Result\n\n```ts\nconst " },
      })
      emit({ type: "session.next.text.delta", data: { sessionID, textID: "markdown", delta: "ok = true\n```\n" } })
      emit({
        type: "session.next.text.ended",
        data: { sessionID, textID: "markdown", text: "## Result\n\n```ts\nconst ok = true\n```\n" },
      })
      emit({ type: "session.next.text.ended", data: { sessionID, textID: "without-deltas", text: "Final-only text" } })
      emit({
        type: "session.next.prompt.admitted",
        data: { sessionID, prompt: { text: "INBOX_PROMPT_MUST_NOT_BE_DUMPED" } },
      })
      emit({ type: "session.next.reasoning.delta", data: { sessionID, delta: "REASONING_FROM_PROVIDER" } })
      emit({
        type: "todo.updated",
        data: {
          sessionID,
          todos: [
            { content: "Inspect the repository", status: "completed", priority: "high" },
            { content: "Implement the fix", status: "in_progress", priority: "medium" },
            { content: "Verify the result", status: "pending", priority: "low" },
          ],
        },
      })
      emit({
        type: "session.next.tool.called",
        data: { sessionID, callID: "tool1", tool: "bash", input: { command: "HUGE_INPUT" } },
      })
      emit({
        type: "session.next.tool.success",
        data: { sessionID, callID: "tool1", content: [{ type: "text", text: "HUGE_OUTPUT" }] },
      })
      emit({ type: "session.next.tool.called", data: { sessionID, callID: "tool2", tool: "edit" } })
      emit({
        type: "session.next.tool.failed",
        data: { sessionID, callID: "tool2", error: { message: "file is read-only" } },
      })
      emit({ type: "session.next.step.failed", data: { sessionID, error: { message: "provider unavailable" } } })
      emit({ type: "session.next.retried", data: { sessionID, attempt: 2, error: { message: "rate limited" } } })
      emit({ type: "permission.v2.asked", data: { sessionID, id: "per_test", action: "edit" } })
      emit({
        type: "question.v2.asked",
        data: { sessionID, id: "que_test", questions: [{ question: "Which target?" }] },
      })
      return Response.json({})
    }
    if (url.pathname === "/test/open-text" || url.pathname === "/test/finish-text") {
      const sessionID = [...sessions.keys()][0]
      const finishing = url.pathname === "/test/finish-text"
      emit({
        type: "session.next.text.delta",
        data: { sessionID, textID: "deferred", delta: finishing ? "ok = true\n```" : "```ts\nconst " },
      })
      if (finishing)
        emit({
          type: "session.next.text.ended",
          data: { sessionID, textID: "deferred", text: "```ts\nconst ok = true\n```" },
        })
      return Response.json({})
    }
    if (url.pathname === "/api/event") {
      state.subscriptions++
      let controller: ReadableStreamDefaultController<Uint8Array>
      return new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            controller = stream
            streams.add(stream)
            stream.enqueue(encoder.encode('event: message\ndata: {"type":"server.connected","data":{}}\n\n'))
          },
          cancel() {
            streams.delete(controller)
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    }
    if (url.pathname === "/api/session" && request.method === "POST") {
      state.creates++
      const body = await request.json()
      sessions.set(body.id, body)
      return Response.json({ data: body })
    }
    const match = /^\/api\/session\/([^/]+)\/prompt$/.exec(url.pathname)
    if (match && request.method === "POST") {
      state.attempts++
      const body = await request.json()
      const input = { ...body, sessionID: match[1] }
      const previous = prompts.get(body.id)
      if (previous && JSON.stringify(previous) !== JSON.stringify(input))
        return new Response("Conflict", { status: 409 })
      prompts.set(body.id, input)
      state.busy = true
      if (process.env.SPEC_TEST_MODE === "retry" && state.attempts === 1)
        return new Response("Response lost after durable admission", { status: 503 })
      if (
        (process.env.SPEC_TEST_MODE === "truncated" && state.attempts === 1) ||
        process.env.SPEC_TEST_MODE === "truncated-always"
      )
        return new Response('{"data":', { headers: { "content-type": "application/json" } })
      if (process.env.SPEC_TEST_MODE === "lost-body" && state.attempts === 1)
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode('{"data":'))
              setTimeout(() => controller.error(new Error("Connection lost during response body")), 20)
            },
          }),
          { headers: { "content-type": "application/json" } },
        )
      if (process.env.SPEC_TEST_MODE === "reject") return new Response("Invalid prompt", { status: 400 })
      if (process.env.SPEC_TEST_MODE === "streaming" && state.attempts > 1) return Response.json({ data: input })
      if (process.env.SPEC_TEST_MODE === "diagnostic" && Bun.argv.includes("--print-logs"))
        console.error("ERROR model resolution failed: test provider is not configured")
      emit({
        type: "session.next.text.delta",
        data: { sessionID: match[1], textID: body.id, delta: `answer ${body.prompt.text}` },
      })
      emit({
        type: "session.next.text.ended",
        data: { sessionID: match[1], textID: body.id, text: `answer ${body.prompt.text}` },
      })
      emit({ type: "session.next.text.delta", data: { sessionID: "ses_other", delta: "must not log this" } })
      return Response.json({ data: input })
    }
    if (url.pathname.endsWith("/interrupt")) state.interrupts++
    return new Response("Unexpected endpoint", { status: 404 })
  },
})
console.log(`opencode server listening on http://127.0.0.1:${server.port}`)

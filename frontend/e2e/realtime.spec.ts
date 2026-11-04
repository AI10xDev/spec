import { test, expect } from "@playwright/test"
import type { Page, Route } from "@playwright/test"
import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

type Channel = {
  label: string; readyState: string; closes: number
  onopen: (() => void) | null; onclose: (() => void) | null
  onerror: (() => void) | null; onmessage: ((event: { data: string }) => void) | null
  emit: (event: unknown) => void; close: () => void
}
type Peer = {
  connectionState: string; iceConnectionState: string; closes: number
  localDescription: RTCSessionDescriptionInit | null; remoteDescription: RTCSessionDescriptionInit | null
  channel: Channel | null; tracks: MediaStreamTrack[]; calls: string[]
  onconnectionstatechange: (() => void) | null; oniceconnectionstatechange: (() => void) | null
  ontrack: ((event: { track: MediaStreamTrack }) => void) | null
  connect: () => void
}
type Harness = {
  permission: "granted" | "denied" | "pending"
  permissions: number; pending: (() => void)[]; peers: Peer[]
  constraints: MediaStreamConstraints[]
  tracks: { kind: "mic" | "remote"; request: number; track: MediaStreamTrack; stops: number }[]
  autoReady: boolean; blockAudio: boolean; plays: number; pauses: number
  mime: string; recorders: MediaRecorder[]; urls: string[]; revoked: string[]; blobs: Blob[]
  nativeRecorder: typeof MediaRecorder
}
declare global { interface Window { __realtimeTest: Harness } }

// Native MediaStreams keep srcObject assertions meaningful without accessing a real microphone.
function installVoiceMocks() {
  const state: Harness = window.__realtimeTest = {
    permission: "granted", permissions: 0, pending: [], peers: [], tracks: [], constraints: [],
    autoReady: true, blockAudio: false, plays: 0, pauses: 0,
    mime: "audio/webm;codecs=opus", recorders: [], urls: [], revoked: [], blobs: [], nativeRecorder: MediaRecorder,
  }
  function stream(kind: "mic" | "remote", request: number) {
    const audio = new AudioContext()
    const destination = audio.createMediaStreamDestination()
    const oscillator = audio.createOscillator()
    oscillator.connect(destination)
    oscillator.start()
    const media = destination.stream
    const track = media.getAudioTracks()[0]
    const record = { kind, request, track, stops: 0 }
    state.tracks.push(record)
    const stop = track.stop.bind(track)
    track.stop = () => { record.stops++; stop(); oscillator.stop(); void audio.close() }
    return media
  }
  Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: async (constraints: MediaStreamConstraints) => {
    if (!constraints.audio || constraints.video) throw new Error("Expected microphone audio only")
    state.constraints.push(constraints)
    const request = ++state.permissions
    if (state.permission === "denied") throw new DOMException("Mock permission denied", "NotAllowedError")
    if (state.permission === "pending") return new Promise<MediaStream>((resolve) => {
      state.pending.push(() => resolve(stream("mic", request)))
    })
    return stream("mic", request)
  } })
  class MockChannel implements Channel {
    readyState = "connecting"
    closes = 0
    onopen: Channel["onopen"] = null
    onclose: Channel["onclose"] = null
    onerror: Channel["onerror"] = null
    onmessage: Channel["onmessage"] = null
    constructor(public label: string) {}
    emit(event: unknown) { this.onmessage?.({ data: JSON.stringify(event) }) }
    close() { this.closes++; this.readyState = "closed"; this.onclose?.() }
  }
  class MockPeer implements Peer {
    connectionState = "new"
    iceConnectionState = "new"
    closes = 0
    localDescription: RTCSessionDescriptionInit | null = null
    remoteDescription: RTCSessionDescriptionInit | null = null
    channel: MockChannel | null = null
    tracks: MediaStreamTrack[] = []
    calls: string[] = []
    onconnectionstatechange: Peer["onconnectionstatechange"] = null
    oniceconnectionstatechange: Peer["oniceconnectionstatechange"] = null
    ontrack: Peer["ontrack"] = null
    constructor() { state.peers.push(this) }
    addTrack(track: MediaStreamTrack, media: MediaStream) {
      if (!media.getTracks().includes(track)) throw new Error("Missing microphone stream")
      this.calls.push("addTrack")
      this.tracks.push(track)
    }
    createDataChannel(label: string) {
      this.calls.push("createDataChannel")
      return this.channel = new MockChannel(label)
    }
    async createOffer() {
      this.calls.push("createOffer")
      if (!this.tracks.length || !this.channel?.onmessage) throw new Error("Offer created before audio/events were configured")
      return { type: "offer" as const, sdp: "mock-offer" }
    }
    async setLocalDescription(description: RTCSessionDescriptionInit) {
      this.calls.push("setLocalDescription")
      this.localDescription = description
    }
    async setRemoteDescription(description: RTCSessionDescriptionInit) {
      this.calls.push("setRemoteDescription")
      if (description.type !== "answer" || description.sdp !== "mock-answer") throw new Error("Unexpected SDP answer")
      this.remoteDescription = description
      this.ontrack?.({ track: stream("remote", state.peers.indexOf(this)).getAudioTracks()[0] })
      if (state.autoReady) {
        this.connect()
        this.channel!.emit({ type: "session.created" })
      }
    }
    connect() {
      this.connectionState = "connected"
      this.onconnectionstatechange?.()
      this.channel!.readyState = "open"
      this.channel!.onopen?.()
    }
    close() { this.closes++; this.connectionState = "closed"; this.onconnectionstatechange?.() }
  }
  Object.defineProperty(window, "RTCPeerConnection", { configurable: true, value: MockPeer })
  class MockRecorder {
    state = "inactive"
    mimeType: string
    ondataavailable: ((event: { data: Blob }) => void) | null = null
    onstop: (() => void) | null = null
    onerror: (() => void) | null = null
    static isTypeSupported(mime: string) { return mime === state.mime }
    constructor(public stream: MediaStream, options: MediaRecorderOptions) {
      this.mimeType = options.mimeType!
      state.recorders.push(this as unknown as MediaRecorder)
    }
    start() { this.state = "recording" }
    stop() {
      this.state = "inactive"
      queueMicrotask(() => {
        this.ondataavailable?.({ data: new Blob(["recorded question"], { type: this.mimeType }) })
        this.onstop?.()
      })
    }
  }
  Object.defineProperty(window, "MediaRecorder", { configurable: true, value: MockRecorder })
  const create = URL.createObjectURL.bind(URL)
  const revoke = URL.revokeObjectURL.bind(URL)
  URL.createObjectURL = (blob) => { const url = create(blob); state.urls.push(url); if (blob instanceof Blob) state.blobs.push(blob); return url }
  URL.revokeObjectURL = (url) => { state.revoked.push(url); revoke(url) }
  HTMLMediaElement.prototype.play = function () {
    state.plays++
    if (state.blockAudio) return Promise.reject(new DOMException("Mock autoplay blocked", "NotAllowedError"))
    this.dispatchEvent(new Event("playing"))
    return Promise.resolve()
  }
  HTMLMediaElement.prototype.pause = function () { state.pauses++ }
  HTMLMediaElement.prototype.load = function () {}
}

let server: ChildProcess
let directory: string
let url: string
let name: string
let errors: string[]
let requests: { sdp: string; name: string; spec: string; output: unknown }[]
let logs: number
const saved = "Saved voice spec"

test.beforeAll(async () => {
  directory = await mkdtemp(path.join(process.env.TMPDIR ?? tmpdir(), "spec-realtime-e2e-"))
  server = spawn(path.resolve("../backend/target/debug/spec"), [], {
    cwd: path.resolve("../backend"),
    env: {
      ...process.env, SPEC_WORKSPACE: directory, SPEC_PORT: "0", SPEC_UI_DIR: path.resolve("dist"),
      SPEC_COMMAND: undefined, SPEC_SSH_TARGET: undefined, SPEC_SSH_WORKSPACE: undefined,
      SPEC_SSH_KEY: undefined, SPEC_SSH_BINARY: undefined, SPEC_OPENCODE: undefined,
      SPEC_SSH_DIR: undefined, SPEC_SSH_IDENTITY: undefined, SPEC_AI_ENV_FILE: "/dev/null",
      SPEC_AZURE_VOICE_ENV_FILE: undefined,
      AZURE_OPENAI_ENDPOINT: undefined, AZURE_OPENAI_API_KEY: undefined,
      DEPLOYMENT_NAME: undefined, AZURE_OPENAI_API_VERSION: undefined,
      OPENAI_API_KEY: undefined, OPENAI_REALTIME_MODEL: undefined,
      AZURE_OPENAI_VOICE_ENDPOINT: undefined, AZURE_OPENAI_VOICE_API_KEY: undefined,
      AZURE_OPENAI_WHISPER_DEPLOYMENT: undefined, AZURE_OPENAI_AUDIO_DEPLOYMENT: undefined,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  url = await new Promise<string>((resolve, reject) => {
    let output = ""
    let stderr = ""
    const timeout = setTimeout(() => reject(new Error(`Rust server did not start: ${stderr}`)), 10_000)
    server.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString() })
    server.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString()
      const match = output.match(/Spec: (http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]+)/)
      if (match) { clearTimeout(timeout); resolve(match[1]) }
    })
    server.on("error", (error) => { clearTimeout(timeout); reject(error) })
    server.on("exit", (code) => { clearTimeout(timeout); reject(new Error(`Rust server exited ${code}: ${stderr}`)) })
  })
})

test.afterAll(async () => {
  if (server && server.exitCode === null) {
    const exited = new Promise<void>((resolve) => server.once("exit", () => resolve()))
    server.kill("SIGTERM")
    await exited
  }
  if (directory) await rm(directory, { recursive: true, force: true })
})

test.beforeEach(async ({ page, context }, info) => {
  name = `voice-${info.testId}.md`
  errors = []
  requests = []
  logs = 0
  page.on("pageerror", (error) => errors.push(error.message))
  context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)))
  await context.addInitScript(installVoiceMocks)
  await context.route("**/api/config", (route) => route.fulfill({ json: { execution: true, completion: false, chat: true, realtime: true, azureVoice: true } }))
  await context.route("**/api/realtime/azure", (route) => { errors.push("Obsolete Azure realtime route requested"); return route.abort() })
  await context.route("**/api/files/*/run", (route) => route.fulfill({ json: {
    id: "voice-run", name, status: "succeeded", output: "Cached output", truncated: false, recoverable: false,
  } }))
  await context.route("**/api/files/*/run/log", (route) => route.fulfill({ json: {
    id: "voice-run", name, status: "succeeded", output: `Fresh output ${++logs}`, truncated: true, recoverable: false,
  } }))
  await context.route("**/api/realtime", (route) => {
    expect(route.request().method()).toBe("POST")
    expect(route.request().headers().authorization).toBe(`Bearer ${new URLSearchParams(new URL(url).hash.slice(1)).get("token")}`)
    requests.push(route.request().postDataJSON())
    return route.fulfill({ json: { sdp: "mock-answer" } })
  })
  await context.route("**/api/chat", (route) => route.fulfill({ json: { answer: "Independent text answer", contextTruncated: false } }))
  await page.goto(url)
  await page.getByRole("textbox", { name: "New filename" }).fill(name)
  await page.getByRole("button", { name: "Create file" }).click()
  await page.getByRole("textbox", { name: `Edit ${name}` }).fill(saved)
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByRole("status")).toHaveText(`Saved ${name}`)
})

test.afterEach(() => { expect(errors).toEqual([]) })

async function openChat(page: Page) {
  const opened = page.waitForEvent("popup")
  await page.getByRole("button", { name: "Open session chat" }).click()
  const chat = await opened
  await expect(chat.getByRole("heading", { name, exact: true })).toBeVisible()
  await expect(chat.getByRole("region", { name: "OpenAI Realtime voice conversation", exact: true })).toBeHidden()
  await chat.getByRole("button", { name: "Open voice conversation", exact: true }).click()
  await expect(chat.getByRole("region", { name: "OpenAI Realtime voice conversation", exact: true })).toBeVisible()
  return chat
}

async function start(chat: Page) {
  await chat.getByRole("button", { name: "Start voice conversation", exact: true }).click()
  await expect(chat.getByRole("button", { name: "Stop voice conversation", exact: true })).toBeVisible()
}

async function expectReleased(chat: Page) {
  await expect.poll(() => chat.evaluate(() => {
    const state = window.__realtimeTest
    return {
      tracks: state.tracks.every(({ track, stops }) => track.readyState === "ended" && stops === 1),
      peers: state.peers.every((peer) => peer.closes === 1 && peer.ontrack === null && peer.onconnectionstatechange === null && peer.oniceconnectionstatechange === null),
      channels: state.peers.every((peer) => peer.channel?.closes === 1 && peer.channel.onmessage === null && peer.channel.onopen === null && peer.channel.onclose === null && peer.channel.onerror === null),
      audio: [...document.querySelectorAll("audio")].every((audio) => audio.srcObject === null),
    }
  })).toEqual({ tracks: true, peers: true, channels: true, audio: true })
}

test("unavailable voice remains separate from working text chat", async ({ page, context }) => {
  await context.route("**/api/config", (route) => route.fulfill({ json: { execution: true, completion: false, chat: true, realtime: false } }))
  const chat = await openChat(page)
  await expect(chat.getByRole("button", { name: "Start voice conversation" })).toBeDisabled()
  await expect(chat.getByText("OpenAI Realtime voice is not configured on the server. Text chat is independent.", { exact: true })).toBeVisible()
  await chat.getByRole("textbox", { name: "Your question" }).fill("Can text still work?")
  await chat.getByRole("button", { name: "Ask", exact: true }).click()
  await expect(chat.getByRole("log", { name: "Conversation", exact: true })).toContainText("Independent text answer")
  expect(await chat.evaluate(() => window.__realtimeTest.permissions)).toBe(0)
  expect(requests).toEqual([])
})

test("authenticated handshake uses fresh context, waits for readiness, plays audio and isolates bounded transcripts across restarts", async ({ page }) => {
  const editor = page.getByRole("textbox", { name: `Edit ${name}` })
  await editor.fill("Unsaved voice context")
  const chat = await openChat(page)
  const panel = chat.getByRole("region", { name: "OpenAI Realtime voice conversation", exact: true })
  await expect(panel).toContainText("Starting sends a snapshot")
  await expect(panel).toContainText("Your microphone transmits audio to OpenAI while connected")
  expect(await chat.evaluate(() => window.__realtimeTest.permissions)).toBe(0)
  await chat.evaluate(() => { window.__realtimeTest.autoReady = false; window.__realtimeTest.blockAudio = true })
  await chat.getByRole("textbox", { name: "Your question" }).fill("Retain this text draft")
  await chat.getByRole("button", { name: "Start voice conversation" }).click()
  await expect.poll(() => chat.evaluate(() => window.__realtimeTest.peers[0]?.remoteDescription)).toEqual({ type: "answer", sdp: "mock-answer" })
  expect(await chat.evaluate(() => window.__realtimeTest.constraints)).toEqual([{ audio: true }])
  expect(requests).toEqual([{
    sdp: "mock-offer", name, spec: "Unsaved voice context",
    output: { id: "voice-run", status: "succeeded", output: "Fresh output 1", truncated: true },
  }])
  expect(await chat.evaluate(() => window.__realtimeTest.peers[0].calls)).toEqual(["addTrack", "createDataChannel", "createOffer", "setLocalDescription", "setRemoteDescription"])
  expect(await chat.evaluate(() => window.__realtimeTest.peers[0].channel!.label)).toBe("oai-events")
  await expect(chat.getByRole("button", { name: "Cancel connection" })).toBeVisible()
  expect(await chat.evaluate(() => window.__realtimeTest.peers[0].tracks[0].enabled)).toBe(false)
  await chat.evaluate(() => window.__realtimeTest.peers[0].connect())
  await expect(chat.getByRole("button", { name: "Cancel connection" })).toBeVisible()
  expect(await chat.evaluate(() => window.__realtimeTest.peers[0].tracks[0].enabled)).toBe(false)
  await chat.evaluate(() => window.__realtimeTest.peers[0].channel!.emit({ type: "session.created" }))
  await expect(chat.getByRole("button", { name: "Stop voice conversation", exact: true })).toBeVisible()
  expect(await chat.evaluate(() => window.__realtimeTest.peers[0].tracks[0].enabled)).toBe(true)
  expect(await panel.locator("audio").evaluate((audio: HTMLAudioElement) => {
    const stream = audio.srcObject
    return stream instanceof MediaStream && stream.getAudioTracks()[0] === window.__realtimeTest.tracks.find((track) => track.kind === "remote")!.track
  })).toBe(true)
  await expect(chat.getByRole("button", { name: "Resume audio" })).toBeVisible()
  await chat.evaluate(() => { window.__realtimeTest.blockAudio = false })
  await chat.getByRole("button", { name: "Resume audio" }).click()
  await expect(chat.getByRole("button", { name: "Resume audio" })).toBeHidden()
  expect(await chat.evaluate(() => window.__realtimeTest.plays)).toBe(2)

  await chat.evaluate(() => {
    const channel = window.__realtimeTest.peers[0].channel!
    channel.onmessage?.({ data: "not JSON" })
    channel.emit(null)
    channel.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "user-1", transcript: "Spoken question" })
    channel.emit({ type: "response.output_audio_transcript.done", item_id: "answer-1", transcript: "<img src=x onerror=alert('xss')> Spoken answer" })
  })
  const transcripts = chat.getByRole("log", { name: "Voice transcripts", exact: true })
  await expect(transcripts.locator("article")).toHaveCount(2)
  await expect(transcripts).toContainText("Spoken question")
  await expect(transcripts).toContainText("<img src=x onerror=alert('xss')> Spoken answer")
  await expect(transcripts.locator("img, script")).toHaveCount(0)
  await expect(chat.getByRole("log", { name: "Conversation", exact: true }).locator("article")).toHaveCount(0)
  await expect(chat.getByRole("textbox", { name: "Your question" })).toHaveValue("Retain this text draft")
  await chat.getByRole("button", { name: "Ask", exact: true }).click()
  await expect(chat.getByRole("log", { name: "Conversation", exact: true })).toContainText("Independent text answer")
  await expect(chat.getByRole("button", { name: "Stop voice conversation", exact: true })).toBeVisible()
  await chat.evaluate(() => {
    const channel = window.__realtimeTest.peers[0].channel!
    for (let i = 0; i < 30; i++) channel.emit({ type: "response.output_audio_transcript.done", item_id: `bounded-${i}`, transcript: i === 29 ? "x".repeat(5000) : `Entry ${i}` })
  })
  await expect(transcripts.locator("article")).toHaveCount(24)
  await expect(transcripts.locator("article").first()).toContainText("Entry 6")
  await expect(transcripts.locator("article").last().locator("div")).toHaveText(`${"x".repeat(4000)} [truncated]`)
  await chat.setViewportSize({ width: 320, height: 740 })
  expect(await chat.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await chat.getByRole("button", { name: "Stop voice conversation", exact: true }).click()
  await expectReleased(chat)

  await editor.fill("New context on restart")
  await chat.evaluate(() => { window.__realtimeTest.autoReady = true })
  await start(chat)
  expect(requests[1]).toEqual({ sdp: "mock-offer", name, spec: "New context on restart", output: { id: "voice-run", status: "succeeded", output: "Fresh output 3", truncated: true } })
  await expect(transcripts).toHaveCount(0)
  await expect(chat.getByRole("log", { name: "Conversation", exact: true })).toContainText("Independent text answer")
  await chat.getByRole("button", { name: "Close voice conversation and stop microphone" }).click()
  await expect(panel).toBeHidden()
  await expectReleased(chat)
})

test("failed responses stop the microphone while normal VAD interruptions keep the session open", async ({ page }) => {
  const chat = await openChat(page)
  await start(chat)
  await chat.evaluate(() => window.__realtimeTest.peers[0].channel!.emit({ type: "response.done", response: { status: "cancelled" } }))
  await expect(chat.getByRole("button", { name: "Stop voice conversation", exact: true })).toBeVisible()
  await expect(chat.getByRole("alert")).toBeHidden()
  await chat.evaluate(() => window.__realtimeTest.peers[0].channel!.emit({ type: "response.done", response: { status: "failed", status_details: { error: { message: "Mock generation failure" } } } }))
  await expect(chat.getByRole("alert")).toContainText("OpenAI Realtime response failed: Mock generation failure")
  await expectReleased(chat)
  await start(chat)
  await expect(chat.getByRole("alert")).toBeHidden()
  await chat.getByRole("button", { name: "Stop voice conversation", exact: true }).click()
  await expectReleased(chat)
})

test("permission denial explains recovery and never starts a session", async ({ page }) => {
  const chat = await openChat(page)
  await chat.evaluate(() => { window.__realtimeTest.permission = "denied" })
  await chat.getByRole("button", { name: "Start voice conversation" }).click()
  await expect(chat.getByRole("alert")).toContainText("Microphone permission was denied or blocked")
  await expect(chat.getByRole("button", { name: "Start voice conversation" })).toBeEnabled()
  expect(requests).toEqual([])
  expect(logs).toBe(0)
  expect(await chat.evaluate(() => window.__realtimeTest.peers.length)).toBe(0)
  await chat.evaluate(() => { window.__realtimeTest.permission = "granted" })
  await start(chat)
  await expect(chat.getByRole("alert")).toBeHidden()
  await chat.getByRole("button", { name: "Stop voice conversation", exact: true }).click()
  await expectReleased(chat)
})

test("API failure releases media and peer resources and permits retry", async ({ page, context }) => {
  await context.route("**/api/realtime", (route) => route.fulfill({ status: 503, json: { error: "Mock voice provider unavailable" } }), { times: 1 })
  const chat = await openChat(page)
  await chat.getByRole("button", { name: "Start voice conversation" }).click()
  await expect(chat.getByRole("alert")).toContainText("Voice session request failed: Mock voice provider unavailable")
  await expectReleased(chat)
  expect(await chat.evaluate(() => window.__realtimeTest.peers[0].remoteDescription)).toBeNull()
  await start(chat)
  await expect(chat.getByRole("alert")).toBeHidden()
  await chat.getByRole("button", { name: "Stop voice conversation", exact: true }).click()
  await expectReleased(chat)
})

test("late microphone permission after cancellation cannot revive or interrupt a restarted session", async ({ page }) => {
  const chat = await openChat(page)
  await chat.evaluate(() => { window.__realtimeTest.permission = "pending" })
  await chat.getByRole("button", { name: "Start voice conversation" }).click()
  await expect.poll(() => chat.evaluate(() => window.__realtimeTest.pending.length)).toBe(1)
  await chat.getByRole("button", { name: "Cancel connection" }).click()
  await chat.evaluate(() => { window.__realtimeTest.permission = "granted" })
  await start(chat)
  await chat.evaluate(() => window.__realtimeTest.pending[0]())
  await expect.poll(() => chat.evaluate(() => window.__realtimeTest.tracks.filter((entry) => entry.kind === "mic").map(({ request, track, stops }) => ({ request, state: track.readyState, stops })))).toEqual([
    { request: 2, state: "live", stops: 0 }, { request: 1, state: "ended", stops: 1 },
  ])
  expect(requests).toHaveLength(1)
  await expect(chat.getByRole("button", { name: "Stop voice conversation", exact: true })).toBeVisible()
  await chat.getByRole("button", { name: "Stop voice conversation", exact: true }).click()
  await expectReleased(chat)
})

test("cancellation during context refresh discards the late snapshot", async ({ page, context }) => {
  const pending: Route[] = []
  await context.route("**/api/files/*/run/log", (route) => { pending.push(route) })
  const chat = await openChat(page)
  await chat.getByRole("button", { name: "Start voice conversation" }).click()
  await expect.poll(() => pending.length).toBe(1)
  await chat.getByRole("button", { name: "Cancel connection" }).click()
  await expectReleased(chat)
  const returned = chat.waitForResponse((response) => response.url().endsWith("/run/log"))
  await pending[0].fulfill({ json: null })
  await returned
  // Drain the fetch continuation, then check that no SDP setup was resumed.
  await expect(chat.getByRole("region", { name: "Chat context" })).toContainText("No associated run output")
  expect(requests).toEqual([])
  expect(await chat.evaluate(() => window.__realtimeTest.peers.length)).toBe(0)
})

test("late SDP response after cancellation cannot affect the next session", async ({ page, context }) => {
  const pending: Route[] = []
  await context.route("**/api/realtime", (route) => { pending.push(route) }, { times: 1 })
  const chat = await openChat(page)
  await chat.getByRole("button", { name: "Start voice conversation" }).click()
  await expect.poll(() => pending.length).toBe(1)
  await chat.getByRole("button", { name: "Cancel connection" }).click()
  await expectReleased(chat)
  await start(chat)
  const returned = chat.waitForResponse((response) => response.url().endsWith("/api/realtime"))
  await pending[0].fulfill({ json: { sdp: "stale-answer-must-not-be-applied" } })
  await (await returned).finished()
  await expect(chat.getByRole("button", { name: "Stop voice conversation", exact: true })).toBeVisible()
  expect(await chat.evaluate(() => window.__realtimeTest.peers.map((peer) => ({ answer: peer.remoteDescription?.sdp ?? null, closes: peer.closes })))).toEqual([
    { answer: null, closes: 1 }, { answer: "mock-answer", closes: 0 },
  ])
  expect(await chat.evaluate(() => window.__realtimeTest.peers[0].calls)).not.toContain("setRemoteDescription")
  await expect(chat.getByRole("alert")).toBeHidden()
  await chat.getByRole("button", { name: "Stop voice conversation", exact: true }).click()
  await expectReleased(chat)
})

test("stalled setup times out with the microphone muted and releases all resources", async ({ page }) => {
  const chat = await openChat(page)
  await chat.clock.install()
  await chat.evaluate(() => { window.__realtimeTest.autoReady = false })
  await chat.getByRole("button", { name: "Start voice conversation" }).click()
  await expect.poll(() => chat.evaluate(() => window.__realtimeTest.peers[0]?.remoteDescription?.sdp)).toBe("mock-answer")
  expect(await chat.evaluate(() => window.__realtimeTest.peers[0].tracks[0].enabled)).toBe(false)
  await chat.clock.fastForward(45_001)
  await expect(chat.getByRole("alert")).toContainText("Voice connection timed out")
  await expectReleased(chat)
  await expect(chat.getByRole("button", { name: "Start voice conversation" })).toBeEnabled()
})

for (const pending of [false, true]) {
  test(`pagehide cleans up ${pending ? "a pending permission request, including its late result" : "connected media and event handlers"}`, async ({ page }) => {
    const chat = await openChat(page)
    if (pending) {
      await chat.evaluate(() => { window.__realtimeTest.permission = "pending" })
      await chat.getByRole("button", { name: "Start voice conversation" }).click()
      await expect.poll(() => chat.evaluate(() => window.__realtimeTest.pending.length)).toBe(1)
    } else await start(chat)
    await chat.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })))
    if (pending) await chat.evaluate(() => window.__realtimeTest.pending[0]())
    await expectReleased(chat)
    await expect(chat.getByRole("button", { name: "Start voice conversation" })).toBeEnabled()
    await chat.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })))
    await expect(chat.getByRole("button", { name: "Start voice conversation" })).toBeVisible()
    expect(requests).toHaveLength(pending ? 0 : 1)
  })
}

for (const unsupported of ["insecure", "missing WebRTC"]) {
  test(`explains ${unsupported} browser support without requesting microphone permission`, async ({ page }) => {
    const chat = await openChat(page)
    await chat.evaluate((reason) => {
      if (reason === "insecure") Object.defineProperty(window, "isSecureContext", { value: false })
      else Object.defineProperty(window, "RTCPeerConnection", { configurable: true, value: undefined })
    }, unsupported)
    await chat.getByRole("button", { name: "Close voice conversation and stop microphone" }).click()
    await chat.getByRole("button", { name: "Open voice conversation", exact: true }).click()
    await expect(chat.getByRole("button", { name: "Start voice conversation" })).toBeDisabled()
    await expect(chat.getByRole("region", { name: "OpenAI Realtime voice conversation", exact: true })).toContainText(unsupported === "insecure" ? "HTTPS or localhost" : "does not support microphone audio and WebRTC")
    expect(await chat.evaluate(() => window.__realtimeTest.permissions)).toBe(0)
    expect(requests).toEqual([])
  })
}

test("Azure records explicit turns independently of text and WebRTC, authenticates fresh context and resumes blocked audio", async ({ page, context }) => {
  await context.route("**/api/config", (route) => route.fulfill({ json: { execution: true, completion: false, chat: false, realtime: false, azureVoice: true } }))
  const azureRequests: unknown[] = []
  await context.route("**/api/voice/azure", (route) => {
    expect(route.request().method()).toBe("POST")
    expect(route.request().headers().authorization).toBe(`Bearer ${new URLSearchParams(new URL(url).hash.slice(1)).get("token")}`)
    azureRequests.push(route.request().postDataJSON())
    return route.fulfill({ json: voiceAnswer })
  })
  await page.getByRole("textbox", { name: `Edit ${name}` }).fill("Unsaved Azure context")
  const chat = await openChat(page)
  await expect(chat.getByRole("button", { name: "Start voice conversation", exact: true })).toBeDisabled()
  await expect(chat.getByRole("textbox", { name: "Your question" })).toBeDisabled()
  await chat.evaluate(() => { Object.defineProperty(window, "RTCPeerConnection", { value: undefined }); window.__realtimeTest.blockAudio = true })
  const panel = await openAzure(chat)
  await expect(panel).toContainText("Only on Send, your recording goes through this server to Azure")
  await expect(panel).toContainText("The voice is AI-generated")
  expect(await chat.evaluate(() => window.__realtimeTest.permissions)).toBe(0)
  await panel.getByRole("button", { name: "Record question", exact: true }).click()
  await expect(panel.getByRole("button", { name: "Send recording" })).toBeVisible()
  expect(azureRequests).toEqual([])
  expect(logs).toBe(0)
  expect(await chat.evaluate(() => window.__realtimeTest.constraints)).toEqual([{
    audio: { echoCancellation: { ideal: true }, noiseSuppression: { ideal: true } },
  }])
  await panel.getByRole("button", { name: "Send recording" }).click()
  await expect(panel.getByRole("button", { name: "Resume audio" })).toBeVisible()
  await expectReleased(chat)
  expect(azureRequests).toEqual([{ audio: Buffer.from("recorded question").toString("base64"), format: "webm", name, spec: "Unsaved Azure context", output: { id: "voice-run", status: "succeeded", output: "Fresh output 1", truncated: true }, messages: [] }])
  expect(await chat.evaluate(() => window.__realtimeTest.peers.length)).toBe(0)
  expect(await panel.locator("audio").evaluate((audio: HTMLAudioElement) => audio.src.startsWith("blob:") && audio.srcObject === null)).toBe(true)
  expect(await chat.evaluate(() => window.__realtimeTest.blobs[0].type)).toBe("audio/mpeg")
  expect(await chat.evaluate(async () => Array.from(new Uint8Array(await window.__realtimeTest.blobs[0].arrayBuffer())))).toEqual(Array.from(Buffer.from(voiceAnswer.audio, "base64")))
  await chat.evaluate(() => { window.__realtimeTest.blockAudio = false })
  await panel.getByRole("button", { name: "Resume audio" }).click()
  await expect(panel.getByRole("button", { name: "Resume audio" })).toBeHidden()
  await expect(panel.getByRole("log")).toContainText("Azure spoken response")
  await expect(chat.getByRole("log", { name: "Conversation", exact: true })).not.toContainText("Azure spoken response")
  await panel.getByRole("button", { name: "Interrupt and record question" }).click()
  await expect(panel.getByRole("button", { name: "Send recording" })).toBeVisible()
  expect(await chat.evaluate(() => window.__realtimeTest.revoked)).toEqual(await chat.evaluate(() => window.__realtimeTest.urls))
  await panel.getByRole("button", { name: "Cancel recording" }).click()
  expect(azureRequests).toHaveLength(1)
  expect(requests).toEqual([])
  await chat.setViewportSize({ width: 320, height: 740 })
  expect(await chat.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await chat.getByRole("button", { name: "Close Azure voice conversation and stop microphone", exact: true }).click()
  await expect(panel).toBeHidden()
  await expectReleased(chat)
})

test("unconfigured Azure mic explains local setup without disabling text chat or OpenAI voice at 320px", async ({ page, context }) => {
  await context.route("**/api/config", (route) => route.fulfill({ json: { execution: true, completion: false, chat: true, realtime: true, azureVoice: false } }))
  const chat = await openChat(page)
  const panel = await openAzure(chat)
  await expect(panel.getByRole("button", { name: "Record question", exact: true })).toBeDisabled()
  await expect(panel).toContainText("Azure voice is not configured on the server")
  await expect(panel).toContainText("Never put provider secrets in the browser")
  await chat.setViewportSize({ width: 320, height: 740 })
  expect(await chat.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  await expect(chat.getByRole("textbox", { name: "Your question" })).toBeEnabled()
  await chat.getByRole("textbox", { name: "Your question" }).fill("Can text still work without Azure voice?")
  await expect(chat.getByRole("button", { name: "Ask", exact: true })).toBeEnabled()
  await chat.getByRole("button", { name: "Ask", exact: true }).click()
  await expect(chat.getByRole("log", { name: "Conversation", exact: true })).toContainText("Independent text answer")
  expect(await chat.evaluate(() => window.__realtimeTest.permissions)).toBe(0)
  expect(requests).toEqual([])
  await start(chat)
  expect(requests).toHaveLength(1)
  await chat.getByRole("button", { name: "Stop voice conversation", exact: true }).click()
  await expectReleased(chat)
})

test("switching providers cancels pending permission and stops connected audio without reviving old sessions", async ({ page }) => {
  const chat = await openChat(page)
  const panel = await openAzure(chat)
  await chat.evaluate(() => { window.__realtimeTest.permission = "pending" })
  await chat.getByRole("button", { name: "Start voice conversation", exact: true }).click()
  await expect.poll(() => chat.evaluate(() => window.__realtimeTest.pending.length)).toBe(1)
  await chat.evaluate(() => { window.__realtimeTest.permission = "granted" })
  await panel.getByRole("button", { name: "Record question", exact: true }).click()
  await expect(panel.getByRole("button", { name: "Send recording" })).toBeVisible()
  await chat.evaluate(() => window.__realtimeTest.pending[0]())
  await expect.poll(() => chat.evaluate(() => window.__realtimeTest.tracks.filter((entry) => entry.kind === "mic").map(({ request, track, stops }) => ({ request, state: track.readyState, stops })))).toEqual([
    { request: 2, state: "live", stops: 0 }, { request: 1, state: "ended", stops: 1 },
  ])
  expect(requests).toEqual([])
  await start(chat)
  await expect(panel.getByRole("button", { name: "Record question", exact: true })).toBeVisible()
  expect(await chat.evaluate(() => window.__realtimeTest.recorders[0].state)).toBe("inactive")
  await panel.getByRole("button", { name: "Record question", exact: true }).click()
  await expect(panel.getByRole("button", { name: "Send recording" })).toBeVisible()
  expect(await chat.evaluate(() => window.__realtimeTest.peers.map((peer) => peer.closes))).toEqual([1])
  await panel.getByRole("button", { name: "Cancel recording" }).click()
  await expectReleased(chat)
})

test("Azure request failures release microphone and can be retried without OpenAI fallback", async ({ page, context }) => {
  await context.route("**/api/voice/azure", (route) => route.fulfill({ json: voiceAnswer }))
  await context.route("**/api/voice/azure", (route) => route.fulfill({ status: 502, json: { error: "Azure voice provider request failed" } }), { times: 1 })
  const chat = await openChat(page)
  const panel = await openAzure(chat)
  await sendAzure(chat)
  await expect(panel.getByRole("alert")).toContainText("Azure voice provider request failed")
  await expectReleased(chat)
  await sendAzure(chat)
  await expect(panel.getByRole("button", { name: "Stop audio", exact: true })).toBeVisible()
  await expect(panel.getByRole("alert")).toBeHidden()
  await chat.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")))
  await expectReleased(chat)
  expect(requests).toEqual([])
})

// Silent MPEG-1 Layer III frames keep native metadata loading valid even with play mocked.
const silentFrame = Buffer.alloc(417)
silentFrame.writeUInt32BE(0xfffb9000)
const voiceAnswer = { transcript: "Spoken question", answer: "Azure spoken response", audio: Buffer.concat(Array(10).fill(silentFrame)).toString("base64"), format: "mp3" }

async function openAzure(chat: Page) {
  await chat.getByRole("button", { name: "Open Azure voice conversation", exact: true }).click()
  return chat.getByRole("region", { name: "Azure voice conversation", exact: true })
}

async function sendAzure(chat: Page) {
  await chat.getByRole("button", { name: "Record question", exact: true }).click()
  await chat.getByRole("button", { name: "Send recording" }).click()
}

test("Azure permission denial and late cancellation cannot revive an old recording", async ({ page }) => {
  const chat = await openChat(page)
  const panel = await openAzure(chat)
  await chat.evaluate(() => { window.__realtimeTest.permission = "denied" })
  await panel.getByRole("button", { name: "Record question", exact: true }).click()
  await expect(panel.getByRole("alert")).toContainText("Microphone permission was denied or blocked")
  expect(logs).toBe(0)
  await chat.evaluate(() => { window.__realtimeTest.permission = "pending" })
  await panel.getByRole("button", { name: "Record question", exact: true }).click()
  await expect.poll(() => chat.evaluate(() => window.__realtimeTest.pending.length)).toBe(1)
  await panel.getByRole("button", { name: "Cancel recording" }).click()
  await chat.evaluate(() => { window.__realtimeTest.permission = "granted" })
  await panel.getByRole("button", { name: "Record question", exact: true }).click()
  await expect(panel.getByRole("button", { name: "Send recording" })).toBeVisible()
  await chat.evaluate(() => window.__realtimeTest.pending[0]())
  expect(await chat.evaluate(() => window.__realtimeTest.tracks.map(({ track, stops }) => [track.readyState, stops]))).toEqual([["live", 0], ["ended", 1]])
  expect(await chat.evaluate(() => window.__realtimeTest.recorders.length)).toBe(1)
  await panel.getByRole("button", { name: "Cancel recording" }).click()
  await expectReleased(chat)
})

for (const reason of ["insecure", "missing microphone", "missing MediaRecorder", "unsupported formats"]) {
  test(`Azure explains ${reason} without requesting permission`, async ({ page }) => {
    const chat = await openChat(page)
    await chat.evaluate((reason) => {
      if (reason === "insecure") Object.defineProperty(window, "isSecureContext", { value: false })
      if (reason === "missing microphone") Object.defineProperty(navigator, "mediaDevices", { value: undefined })
      if (reason === "missing MediaRecorder") Object.defineProperty(window, "MediaRecorder", { value: undefined })
      if (reason === "unsupported formats") window.__realtimeTest.mime = "audio/unsupported"
    }, reason)
    const panel = await openAzure(chat)
    await expect(panel.getByRole("button", { name: "Record question", exact: true })).toBeDisabled()
    await expect(panel).toContainText(reason === "insecure" ? "HTTPS or localhost" : reason === "unsupported formats" ? "supported WebM, MP4 or WAV" : "does not support microphone recording")
    expect(await chat.evaluate(() => window.__realtimeTest.permissions)).toBe(0)
  })
}

for (const format of ["webm", "mp4", "wav"]) {
  test(`Azure sends negotiated ${format} recording bytes, never an SDP offer`, async ({ page, context }) => {
    const bodies: { format: string; audio: string }[] = []
    await context.route("**/api/voice/azure", (route) => { bodies.push(route.request().postDataJSON()); return route.fulfill({ json: voiceAnswer }) })
    const chat = await openChat(page)
    await chat.evaluate((format) => { window.__realtimeTest.mime = `audio/${format}` }, format)
    const panel = await openAzure(chat)
    await sendAzure(chat)
    await expect(panel.getByRole("button", { name: "Stop audio" })).toBeVisible()
    expect(bodies[0].format).toBe(format)
    expect(Buffer.from(bodies[0].audio, "base64").toString()).toBe("recorded question")
    expect(await chat.evaluate(() => window.__realtimeTest.recorders[0].mimeType)).toBe(`audio/${format}`)
    expect(await chat.evaluate(() => window.__realtimeTest.peers.length)).toBe(0)
    await panel.getByRole("button", { name: "Stop audio" }).click()
    await expectReleased(chat)
    expect(await chat.evaluate(() => window.__realtimeTest.revoked)).toEqual(await chat.evaluate(() => window.__realtimeTest.urls))
  })
}

test("Azure bounds complete history to four pairs and clears it when the displayed run changes", async ({ page, context }) => {
  let run = "voice-run"
  const bodies: { messages: { role: string; content: string }[]; output: { id: string; output: string }; spec: string }[] = []
  await context.route("**/api/files/*/run", (route) => route.fulfill({ json: { id: run, name, status: "succeeded", output: "Cached output", truncated: false } }))
  await context.route("**/api/files/*/run/log", (route) => route.fulfill({ json: { id: run, name, status: "succeeded", output: `Log ${++logs}`, truncated: false } }))
  await context.route("**/api/voice/azure", (route) => {
    bodies.push(route.request().postDataJSON())
    return route.fulfill({ json: { ...voiceAnswer, transcript: `Question ${bodies.length}`, answer: `Answer ${bodies.length}` } })
  })
  const chat = await openChat(page)
  const panel = await openAzure(chat)
  await chat.clock.install()
  await chat.getByRole("textbox", { name: "Your question" }).fill("Separate text draft")
  for (let i = 0; i < 10; i++) {
    await page.getByRole("textbox", { name: `Edit ${name}` }).fill(`Spec turn ${i}`)
    await sendAzure(chat)
    await expect(panel.getByRole("button", { name: "Stop audio" })).toBeVisible()
    expect(bodies[i].messages).toHaveLength(Math.min(i, 4) * 2)
    expect(bodies[i].messages.every((message, index) => message.role === (index % 2 ? "assistant" : "user"))).toBe(true)
    expect(bodies[i].spec).toBe(`Spec turn ${i}`)
    expect(bodies[i].output.output).toBe(`Log ${i + 1}`)
    await panel.locator("audio").dispatchEvent("ended")
    await expect(panel.getByRole("button", { name: "Record question", exact: true })).toBeVisible()
  }
  expect(bodies[9].messages[0]).toEqual({ role: "user", content: "Question 6" })
  await expect(panel.getByRole("log").locator("article")).toHaveCount(8)
  await expect(panel.getByRole("log")).toContainText("Latest 4 complete question/answer pairs.")
  await expect(chat.getByRole("textbox", { name: "Your question" })).toHaveValue("Separate text draft")
  await expect(chat.getByRole("log", { name: "Conversation", exact: true }).locator("article")).toHaveCount(0)
  run = "new-run"
  await chat.clock.fastForward(3100)
  await expect(chat.getByRole("region", { name: "Chat context" })).toContainText("new-run")
  await expect(panel.getByRole("log")).toHaveCount(0)
  await sendAzure(chat)
  await expect(panel.getByRole("button", { name: "Stop audio" })).toBeVisible()
  expect(bodies[10].messages).toEqual([])
  expect(bodies[10].output.id).toBe("new-run")
})

test("Azure releases mic before context refresh and discards cancelled late context", async ({ page, context }) => {
  const pending: Route[] = []
  let voiceRequests = 0
  await context.route("**/api/files/*/run/log", (route) => { pending.push(route) })
  await context.route("**/api/voice/azure", (route) => { voiceRequests++; return route.fulfill({ json: voiceAnswer }) })
  const chat = await openChat(page)
  const panel = await openAzure(chat)
  await sendAzure(chat)
  await expect.poll(() => pending.length).toBe(1)
  await expectReleased(chat)
  await panel.getByRole("button", { name: "Cancel response" }).click()
  await pending[0].fulfill({ json: { id: "voice-run", status: "succeeded", output: "Late context", truncated: false } })
  await expect(chat.getByRole("region", { name: "Chat context" }).locator("pre").last()).toHaveText("Late context")
  expect(voiceRequests).toBe(0)
  expect(await chat.evaluate(() => window.__realtimeTest.plays)).toBe(0)
  await expect(panel.getByRole("button", { name: "Record question", exact: true })).toBeVisible()
})

for (const interrupt of ["new recording", "OpenAI", "close", "pagehide"]) {
  test(`Azure late response cannot play after ${interrupt}`, async ({ page, context }) => {
    const pending: Route[] = []
    await context.route("**/api/voice/azure", (route) => { pending.push(route) })
    const chat = await openChat(page)
    // Simulate a transport that cannot abort, so this exercises the epoch guard too.
    await chat.evaluate(() => {
      const original = window.fetch
      window.fetch = (input, init) => original(input, String(input).endsWith("/voice/azure") ? { ...init, signal: undefined } : init)
    })
    const panel = await openAzure(chat)
    await sendAzure(chat)
    await expect.poll(() => pending.length).toBe(1)
    await expectReleased(chat)
    if (interrupt === "new recording") await panel.getByRole("button", { name: "Interrupt and record question" }).click()
    if (interrupt === "OpenAI") await start(chat)
    if (interrupt === "close") await chat.getByRole("button", { name: "Close Azure voice conversation and stop microphone" }).click()
    if (interrupt === "pagehide") await chat.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")))
    const plays = await chat.evaluate(() => window.__realtimeTest.plays)
    const response = chat.waitForResponse((response) => response.url().endsWith("/voice/azure"))
    await pending[0].fulfill({ json: voiceAnswer })
    await (await response).finished()
    await expect(panel.getByRole("log")).toHaveCount(0)
    expect(await chat.evaluate(() => window.__realtimeTest.urls)).toEqual([])
    expect(await chat.evaluate(() => window.__realtimeTest.plays)).toBe(plays)
    if (interrupt === "new recording") await panel.getByRole("button", { name: "Cancel recording" }).click()
    if (interrupt === "OpenAI") await chat.getByRole("button", { name: "Stop voice conversation", exact: true }).click()
    await expectReleased(chat)
  })
}

for (const pending of [false, true]) {
  for (const action of ["close", "pagehide", "OpenAI"]) {
    test(`Azure ${action} releases ${pending ? "late permission" : "recording"}`, async ({ page }) => {
      const chat = await openChat(page)
      const panel = await openAzure(chat)
      if (pending) await chat.evaluate(() => { window.__realtimeTest.permission = "pending" })
      await panel.getByRole("button", { name: "Record question", exact: true }).click()
      if (pending) await expect.poll(() => chat.evaluate(() => window.__realtimeTest.pending.length)).toBe(1)
      else await expect(panel.getByRole("button", { name: "Send recording" })).toBeVisible()
      if (action === "close") await chat.getByRole("button", { name: "Close Azure voice conversation and stop microphone" }).click()
      if (action === "pagehide") await chat.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")))
      if (action === "OpenAI") {
        await chat.evaluate(() => { window.__realtimeTest.permission = "granted" })
        await start(chat)
        await chat.getByRole("button", { name: "Stop voice conversation", exact: true }).click()
      }
      if (pending) await chat.evaluate(() => window.__realtimeTest.pending[0]())
      await expectReleased(chat)
      expect(await chat.evaluate(() => window.__realtimeTest.recorders.every((recorder) => recorder.state === "inactive"))).toBe(true)
    })
  }
}

test("Azure 60-second cap stops capture without sending until explicit Send", async ({ page, context }) => {
  let sent = 0
  await context.route("**/api/voice/azure", (route) => { sent++; return route.fulfill({ json: voiceAnswer }) })
  const chat = await openChat(page)
  const panel = await openAzure(chat)
  await chat.clock.install()
  await panel.getByRole("button", { name: "Record question", exact: true }).click()
  await expect(panel.getByRole("button", { name: "Send recording" })).toBeVisible()
  await chat.clock.fastForward(60_001)
  await expect(panel).toContainText("60-second limit reached")
  await expectReleased(chat)
  expect(sent).toBe(0)
  expect(await chat.evaluate(() => window.__realtimeTest.recorders[0].state)).toBe("inactive")
  await panel.getByRole("button", { name: "Send recording" }).click()
  await expect(panel.getByRole("button", { name: "Stop audio" })).toBeVisible()
  expect(sent).toBe(1)
})

for (const failure of ["size", "recorder", "microphone", "format"]) {
  test(`Azure ${failure} capture failure releases microphone and never sends`, async ({ page }) => {
    const chat = await openChat(page)
    const panel = await openAzure(chat)
    await panel.getByRole("button", { name: "Record question", exact: true }).click()
    await expect(panel.getByRole("button", { name: "Send recording" })).toBeVisible()
    await chat.evaluate((failure) => {
      const recorder = window.__realtimeTest.recorders[0]
      if (failure === "size") recorder.ondataavailable?.(new BlobEvent("dataavailable", { data: new Blob([new Uint8Array(4 * 1024 * 1024 + 1)], { type: recorder.mimeType }) }))
      if (failure === "recorder") recorder.onerror?.(new ErrorEvent("error"))
      if (failure === "microphone") window.__realtimeTest.tracks[0].track.dispatchEvent(new Event("ended"))
      if (failure === "format") Object.defineProperty(recorder, "mimeType", { value: "audio/ogg" })
    }, failure)
    if (failure === "format") await panel.getByRole("button", { name: "Send recording" }).click()
    await expect(panel.getByRole("alert")).toContainText(failure === "size" ? "exceeded 4 MiB" : failure === "format" ? "unsupported recording format" : failure === "microphone" ? "Microphone access ended" : "Microphone recording failed")
    await expectReleased(chat)
    expect(logs).toBe(0)
  })
}

test("Azure playback errors revoke Blob URLs and preserve readable transcripts", async ({ page, context }) => {
  await context.route("**/api/voice/azure", (route) => route.fulfill({ json: { ...voiceAnswer, answer: "<img src=x onerror=alert('xss')> Azure answer" } }))
  const chat = await openChat(page)
  const panel = await openAzure(chat)
  await sendAzure(chat)
  await expect(panel.getByRole("button", { name: "Stop audio" })).toBeVisible()
  await panel.locator("audio").dispatchEvent("error")
  await expect(panel.getByRole("alert")).toContainText("Answer audio could not be played")
  await expect(panel.getByRole("log")).toContainText("<img src=x onerror=alert('xss')> Azure answer")
  await expect(panel.locator("img, script")).toHaveCount(0)
  expect(await panel.locator("audio").getAttribute("src")).toBeNull()
  expect(await chat.evaluate(() => window.__realtimeTest.revoked)).toEqual(await chat.evaluate(() => window.__realtimeTest.urls))
  await expectReleased(chat)
})

test("Azure native MediaRecorder produces a real WebM container from the mocked microphone", async ({ page, context }) => {
  const bodies: { format: string; audio: string }[] = []
  await context.route("**/api/voice/azure", (route) => { bodies.push(route.request().postDataJSON()); return route.fulfill({ json: voiceAnswer }) })
  const chat = await openChat(page)
  await chat.evaluate(() => { Object.defineProperty(window, "MediaRecorder", { value: window.__realtimeTest.nativeRecorder }) })
  const panel = await openAzure(chat)
  await panel.getByRole("button", { name: "Record question", exact: true }).click()
  await expect(panel.getByRole("button", { name: "Send recording" })).toBeVisible()
  // Let the real encoder capture audio; its media clock is not Playwright's fake timer.
  await chat.waitForTimeout(400)
  await panel.getByRole("button", { name: "Send recording" }).click()
  await expect(panel.getByRole("button", { name: "Stop audio" })).toBeVisible()
  expect(bodies[0].format).toBe("webm")
  expect(Buffer.from(bodies[0].audio, "base64").subarray(0, 4).toString("hex")).toBe("1a45dfa3")
  await expectReleased(chat)
})

test("Azure fresh context failures never submit recorded audio", async ({ page, context }) => {
  let sent = 0
  await context.route("**/api/files/*/run/log", (route) => route.fulfill({ status: 503, json: { error: "Fresh output unavailable" } }))
  await context.route("**/api/voice/azure", (route) => { sent++; return route.fulfill({ json: voiceAnswer }) })
  const chat = await openChat(page)
  const panel = await openAzure(chat)
  await sendAzure(chat)
  await expect(panel.getByRole("alert")).toContainText("Fresh output unavailable")
  await expectReleased(chat)
  expect(sent).toBe(0)
})

test("Azure run changes cancel an in-flight answer and ignore its late result", async ({ page, context }) => {
  let run = "voice-run"
  const pending: Route[] = []
  await context.route("**/api/files/*/run", (route) => route.fulfill({ json: { id: run, name, status: "succeeded", output: "Cached output", truncated: false } }))
  await context.route("**/api/voice/azure", (route) => { pending.push(route) })
  const chat = await openChat(page)
  await chat.evaluate(() => {
    const original = window.fetch
    window.fetch = (input, init) => original(input, String(input).endsWith("/voice/azure") ? { ...init, signal: undefined } : init)
  })
  const panel = await openAzure(chat)
  await chat.clock.install()
  await sendAzure(chat)
  await expect.poll(() => pending.length).toBe(1)
  run = "new-run"
  await chat.clock.fastForward(3100)
  await expect(panel).toContainText("Session changed")
  await expect(panel.getByRole("button", { name: "Record question", exact: true })).toBeVisible()
  const response = chat.waitForResponse((response) => response.url().endsWith("/voice/azure"))
  await pending[0].fulfill({ json: voiceAnswer })
  await (await response).finished()
  await expect(panel.getByRole("log")).toHaveCount(0)
  expect(await chat.evaluate(() => window.__realtimeTest.urls)).toEqual([])
  await expectReleased(chat)
})

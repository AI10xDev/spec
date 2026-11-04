import { useEffect, useId, useRef, useState } from "react"

type Message = { role: "user" | "assistant"; content: string }
type Props = {
  api: <T>(path: string, body?: unknown, method?: string, signal?: AbortSignal) => Promise<T>
  available: boolean
  runId: string | null
  onStart: (stop: () => void) => void
  context: () => Promise<{ name: string; spec: string; output: null | { id: string; status: string; output: string; truncated: boolean } }>
}
type Turn = { dispose: () => void; finish: (send: boolean) => void; send: () => Promise<void>; play: () => Promise<void> }
const limit = 4 * 1024 * 1024
const formats = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/wav"]

export function AzureVoice({ api, available, runId, onStart, context }: Props) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState<"idle" | "permission" | "recording" | "ready" | "generating" | "playing" | "blocked">("idle")
  const [status, setStatus] = useState("Microphone off. Record a question when ready.")
  const [error, setError] = useState("")
  const [messages, setMessages] = useState<Message[]>([])
  const history = useRef<Message[]>([])
  const historyRun = useRef(runId)
  const turn = useRef<Turn | null>(null)
  const audio = useRef<HTMLAudioElement>(null)
  const unsupported = !window.isSecureContext
    ? "Voice requires HTTPS or localhost."
    : !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined"
      ? "This browser does not support microphone recording with MediaRecorder. Try a current browser."
      : !formats.some((mime) => MediaRecorder.isTypeSupported(mime))
        ? "This browser cannot record a supported WebM, MP4 or WAV audio format."
        : ""

  function stop() {
    turn.current?.dispose()
    setPhase("idle")
    setStatus("Microphone off. Recording or response stopped.")
  }

  useEffect(() => {
    window.addEventListener("pagehide", stop)
    return () => { window.removeEventListener("pagehide", stop); turn.current?.dispose() }
  }, [])
  useEffect(() => { if (!available) stop() }, [available])
  useEffect(() => {
    if (historyRun.current === runId) return
    stop()
    historyRun.current = runId
    history.current = []
    setMessages([])
    setError("")
    setStatus("Session changed. Azure voice history cleared. Microphone off.")
  }, [runId])

  async function record() {
    if (!available || unsupported) return
    onStart(stop)
    stop()
    const playback = audio.current!
    let microphone: MediaStream | undefined
    let recorder: MediaRecorder | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let chunks: Blob[] = []
    let size = 0
    let recording: Blob | undefined
    let sending = false
    let finishing = false
    let url: string | undefined
    const controller = new AbortController()
    const current = () => turn.current === attempt
    function releaseMic() {
      clearTimeout(timer)
      microphone?.getTracks().forEach((track) => { track.onended = null; track.stop() })
      microphone = undefined
    }
    function fail(cause: unknown) {
      if (!current()) return
      attempt.dispose()
      setPhase("idle")
      setStatus("Microphone off.")
      setError(cause instanceof Error ? cause.message : String(cause))
    }
    const attempt: Turn = {
      dispose() {
        if (!current()) return
        // Invalidate before stopping: permission, recorder, fetch and play promises can finish late.
        turn.current = null
        controller.abort()
        if (recorder) {
          recorder.ondataavailable = recorder.onstop = recorder.onerror = null
          if (recorder.state !== "inactive") recorder.stop()
        }
        releaseMic()
        chunks = []
        recording = undefined
        playback.onended = playback.onerror = null
        playback.pause()
        playback.removeAttribute("src")
        playback.load()
        if (url) URL.revokeObjectURL(url)
      },
      finish(send) {
        if (!current() || finishing || !recorder || recorder.state === "inactive") return
        finishing = true
        setPhase("generating")
        setStatus(send ? "Microphone off. Preparing recording..." : "60-second limit reached. Microphone off. Send or cancel this recording.")
        recorder.onstop = () => {
          if (!current()) return
          const mime = recorder!.mimeType || chunks[0]?.type
          if (!mime || chunks.some((chunk) => chunk.type && chunk.type.split(";")[0] !== mime.split(";")[0])) {
            fail(new Error("The browser returned inconsistent recording formats.")); return
          }
          recording = new Blob(chunks, { type: mime })
          chunks = []
          if (!recording.size || recording.size > limit) { fail(new Error("Recording must contain audio and be no larger than 4 MiB.")); return }
          if (send) void attempt.send()
          else setPhase("ready")
        }
        recorder.stop()
        releaseMic()
      },
      async send() {
        if (!current() || !recording || sending) return
        sending = true
        setPhase("generating")
        setStatus("Microphone off. Refreshing context and generating an Azure answer...")
        try {
          const mime = recording.type.split(";")[0]
          const format = mime === "audio/webm" ? "webm" : mime === "audio/mp4" ? "mp4" : mime === "audio/wav" ? "wav" : null
          if (!format) throw new Error("The browser returned an unsupported recording format.")
          const bytes = new Uint8Array(await recording.arrayBuffer())
          let binary = ""
          for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
          const snapshot = await context()
          if (!current()) return
          const run = snapshot.output?.id ?? null
          if (historyRun.current !== run) { history.current = []; setMessages([]) }
          historyRun.current = run
          const prior = history.current.slice(-8)
          const response = await api<{ transcript: string; answer: string; audio: string; format: string }>("/voice/azure", {
            audio: btoa(binary), format, name: snapshot.name, spec: snapshot.spec, output: snapshot.output, messages: prior,
          }, "POST", controller.signal)
          if (!current()) return
          if (!response || typeof response.transcript !== "string" || !response.transcript.trim() || typeof response.answer !== "string" || !response.answer.trim() || response.format !== "mp3" || typeof response.audio !== "string" || !response.audio) throw new Error("Azure returned an invalid voice response.")
          const decoded = Uint8Array.from(atob(response.audio), (char) => char.charCodeAt(0))
          url = URL.createObjectURL(new Blob([decoded], { type: "audio/mpeg" }))
          history.current = [...prior, { role: "user", content: response.transcript }, { role: "assistant", content: response.answer }].slice(-8) as Message[]
          setMessages(history.current)
          recording = undefined
          playback.src = url
          playback.onended = () => { if (current()) { stop(); setStatus("Answer finished. Microphone off.") } }
          playback.onerror = () => fail(new Error("Answer audio could not be played. The transcript is available below."))
          await attempt.play()
        } catch (cause) { fail(cause) }
      },
      async play() {
        if (!current() || !url) return
        setPhase("playing")
        setStatus("Playing AI-generated Azure voice. Microphone off.")
        try { await playback.play() } catch (cause) {
          if (!current()) return
          if (cause instanceof Error && cause.name === "NotAllowedError") {
            setPhase("blocked")
            setStatus("Audio autoplay was blocked. Select Resume audio. Microphone off.")
          } else fail(new Error("Answer audio could not be played. The transcript is available below."))
        }
      },
    }
    turn.current = attempt
    setError("")
    setPhase("permission")
    setStatus("Waiting for microphone permission...")
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: { ideal: true }, noiseSuppression: { ideal: true } } })
      if (!current()) { stream.getTracks().forEach((track) => track.stop()); return }
      microphone = stream
      if (!stream.getAudioTracks().some((track) => track.readyState === "live")) throw new Error("No live microphone track was provided.")
      for (const track of stream.getAudioTracks()) track.onended = () => fail(new Error("Microphone access ended. Check your device and permissions."))
      const mimeType = formats.find((mime) => MediaRecorder.isTypeSupported(mime))!
      recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 128_000 })
      recorder.ondataavailable = ({ data }) => {
        if (!current() || !data.size) return
        size += data.size
        if (size > limit) { fail(new Error("Recording exceeded 4 MiB and was discarded. Record a shorter question.")); return }
        chunks.push(data)
      }
      recorder.onerror = () => fail(new Error("Microphone recording failed. Please try again."))
      recorder.start(250)
      timer = setTimeout(() => attempt.finish(false), 60_000)
      setPhase("recording")
      setStatus("Recording your question locally. Send when ready; maximum 60 seconds / 4 MiB.")
    } catch (cause) {
      fail(cause instanceof Error && ["NotAllowedError", "SecurityError"].includes(cause.name)
        ? new Error("Microphone permission was denied or blocked. Allow microphone access in browser/site settings and try again.") : cause)
    }
  }

  return <>
    <div className="chat-tools"><button type="button" className="mic-button" aria-expanded={open} aria-controls={id} aria-label={open ? "Close Azure voice conversation and stop microphone" : "Open Azure voice conversation"} onClick={() => { if (open) stop(); setOpen(!open) }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" focusable="false"><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" /></svg>
      {open ? "Close Azure voice" : "Azure mic"}
    </button></div>
    <section id={id} className="realtime-panel" hidden={!open} aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`}>Azure voice conversation</h2>
      <p className="hint" id={`${id}-privacy`}>Record a question, then Send recording. Only on Send, your recording goes through this server to Azure for Whisper speech recognition and a gpt-audio-mini spoken answer, along with this file's name, fresh spec, available output and recent Azure voice history. The voice is AI-generated. The microphone is off during the answer; background noise cannot interrupt it. Stop audio or explicitly record a new question to interrupt. Text chat and OpenAI voice stay separate; starting either provider stops the other.</p>
      {!available && <p className="hint">Azure voice is not configured on the server. Text chat and OpenAI voice are independent. Ask the server administrator to configure Whisper and gpt-audio-mini, then reload this page. Never put provider secrets in the browser.</p>}
      {unsupported && <p className="hint">{unsupported}</p>}
      <p role="status" aria-live="polite">{status}</p>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="chat-tools">
        {phase === "idle" && <button type="button" className="mic-button" disabled={!available || !!unsupported} aria-describedby={`${id}-privacy`} onClick={() => void record()}>Record question</button>}
        {(phase === "recording" || phase === "ready") && <button type="button" className="primary" onClick={() => phase === "recording" ? turn.current?.finish(true) : void turn.current?.send()}>Send recording</button>}
        {["permission", "recording", "ready"].includes(phase) && <button type="button" onClick={stop}>Cancel recording</button>}
        {phase === "generating" && <button type="button" onClick={stop}>Cancel response</button>}
        {(phase === "playing" || phase === "blocked") && <button type="button" onClick={stop}>Stop audio</button>}
        {phase === "blocked" && <button type="button" onClick={() => void turn.current?.play()}>Resume audio</button>}
        {["generating", "playing", "blocked"].includes(phase) && <button type="button" onClick={() => void record()}>Interrupt and record question</button>}
      </div>
      <audio ref={audio} preload="none" />
      {!!messages.length && <div className="chat-messages" role="log" aria-label="Azure voice transcripts" aria-live="polite"><p className="hint">Latest 4 complete question/answer pairs. Speech recognition may be imperfect.</p>{messages.map((message, index) => <article className={`chat-message ${message.role}`} key={index}><h3>{message.role === "user" ? "You" : "Azure voice assistant"}</h3><div>{message.content}</div></article>)}</div>}
    </section>
  </>
}

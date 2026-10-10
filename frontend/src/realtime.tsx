import { useEffect, useId, useRef, useState } from "react"

type Props = {
  api: <T>(path: string, body?: unknown, method?: string) => Promise<T>
  available: boolean
  provider: "openai" | "azure"
  onStart: (stop: () => void) => void
  context: () => Promise<{
    name: string
    spec: string
    output: null | { id: string; status: string; output: string; truncated: boolean }
  }>
}
type Transcript = { id: string; role: "user" | "assistant"; text: string }

export function Realtime({ api, available, provider, onStart, context }: Props) {
  const azure = provider === "azure"
  const service = azure ? "Azure OpenAI" : "OpenAI"
  const conversation = azure ? "Azure voice conversation" : "voice conversation"
  const id = useId()
  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState<"idle" | "connecting" | "connected">("idle")
  const [status, setStatus] = useState("Microphone off.")
  const [error, setError] = useState("")
  const [audioBlocked, setAudioBlocked] = useState(false)
  const [transcripts, setTranscripts] = useState<Transcript[]>([])
  const audio = useRef<HTMLAudioElement>(null)
  const session = useRef<{ dispose: () => void; play: () => Promise<void> } | null>(null)
  const unsupported = typeof window === "undefined" || !window.isSecureContext
    ? "Voice requires a secure page. Open this app using HTTPS or localhost."
    : !navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined" || typeof MediaStream === "undefined"
      ? "This browser does not support microphone audio and WebRTC. Try a current browser."
      : ""

  function stop() {
    session.current?.dispose()
    setPhase("idle")
    setStatus("Disconnected. Microphone off.")
    setAudioBlocked(false)
  }

  useEffect(() => {
    window.addEventListener("pagehide", stop)
    return () => {
      window.removeEventListener("pagehide", stop)
      session.current?.dispose()
    }
  }, [])

  useEffect(() => {
    if (!available) stop()
  }, [available])

  async function start() {
    if (session.current || !available || unsupported) return
    const playback = audio.current
    if (!playback) return
    onStart(stop)
    let peer: RTCPeerConnection | undefined
    let channel: RTCDataChannel | undefined
    let microphone: MediaStream | undefined
    let remote: MediaStream | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let answerApplied = false
    let sessionCreated = false
    let connected = false
    let stage = "Microphone access failed"
    const current = () => session.current === attempt
    const attempt = {
      dispose() {
        if (!current()) return
        // Invalidate first: late permission, SDP, context, and playback results cannot revive this session.
        session.current = null
        clearTimeout(timer)
        if (microphone) for (const track of microphone.getTracks()) {
          track.onended = null
          track.stop()
        }
        if (channel) {
          channel.onopen = channel.onclose = channel.onerror = channel.onmessage = null
          channel.close()
        }
        if (peer) {
          peer.ontrack = peer.onconnectionstatechange = peer.oniceconnectionstatechange = null
          peer.close()
        }
        playback.onplaying = null
        playback.pause()
        playback.srcObject = null
        remote?.getTracks().forEach((track) => track.stop())
      },
      async play() {
        if (!current() || !playback.srcObject) return
        try {
          await playback.play()
          if (current()) setAudioBlocked(false)
        } catch {
          if (current()) setAudioBlocked(true)
        }
      },
    }
    session.current = attempt
    setPhase("connecting")
    setStatus("Waiting for microphone permission...")
    setError("")
    setAudioBlocked(false)
    setTranscripts([])

    function fail(message: string) {
      if (!current()) return
      attempt.dispose()
      setPhase("idle")
      setStatus("Disconnected. Microphone off.")
      setAudioBlocked(false)
      setError(message)
    }

    function ready() {
      if (!current() || connected || !answerApplied || !sessionCreated || peer?.connectionState !== "connected" || channel?.readyState !== "open") return
      connected = true
      clearTimeout(timer)
      microphone?.getAudioTracks().forEach((track) => { track.enabled = true })
      setPhase("connected")
      setStatus("Connected. Microphone live: speak naturally; the assistant responds after you pause.")
    }

    timer = setTimeout(() => fail("Voice connection timed out. Check microphone permission and your network, then try again."), 45_000)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (!current()) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      microphone = stream
      if (!stream.getAudioTracks().some((track) => track.readyState === "live")) throw new Error("No live microphone track was provided.")
      for (const track of stream.getAudioTracks()) {
        track.enabled = false
        track.onended = () => fail("Microphone access ended. Check your device and permissions, then start again.")
      }

      stage = "Context refresh failed"
      setStatus("Refreshing the spec and output snapshot...")
      const snapshot = await context()
      if (!current()) return

      stage = "WebRTC setup failed"
      setStatus(`Connecting to ${service} Realtime...`)
      peer = new RTCPeerConnection()
      remote = new MediaStream()
      playback.srcObject = remote
      playback.onplaying = () => { if (current()) setAudioBlocked(false) }
      peer.ontrack = (event) => {
        if (!current()) { event.track.stop(); return }
        remote!.addTrack(event.track)
        void attempt.play()
      }
      peer.onconnectionstatechange = () => {
        if (!current()) return
        if (["failed", "disconnected", "closed"].includes(peer!.connectionState)) {
          fail("Voice connection was lost. Check your network, then start a new conversation.")
        } else ready()
      }
      peer.oniceconnectionstatechange = () => {
        if (peer?.iceConnectionState === "failed") fail("The voice network connection failed. A firewall or VPN may be blocking WebRTC.")
      }
      for (const track of stream.getAudioTracks()) peer.addTrack(track, stream)
      channel = peer.createDataChannel("oai-events")
      channel.onopen = ready
      channel.onclose = () => fail("The voice session ended. Start again to reconnect.")
      channel.onerror = () => fail("The voice event channel failed. Check your network and try again.")
      channel.onmessage = ({ data }) => {
        if (!current() || typeof data !== "string") return
        let event: {
          type?: string; item_id?: string; content_index?: number; event_id?: string
          transcript?: string; error?: { message?: string }
          response?: { status?: string; status_details?: { error?: { message?: string } } }
        }
        try { event = JSON.parse(data) } catch { return }
        if (!event || typeof event.type !== "string") return
        if (event.type === "session.created") {
          sessionCreated = true
          ready()
        } else if (event.type === "error") {
          fail(`${service} Realtime: ${typeof event.error?.message === "string" ? event.error.message.slice(0, 1000) : "The provider reported a session error. Try connecting again."}`)
        } else if (event.type === "response.done" && event.response?.status === "failed") {
          const message = event.response.status_details?.error?.message
          fail(`${service} Realtime response failed: ${typeof message === "string" ? message.slice(0, 1000) : "The provider could not generate an answer."} Start a new voice conversation to retry.`)
        } else if (event.type === "response.output_audio_transcript.done" || event.type === "conversation.item.input_audio_transcription.completed") {
          if (typeof event.transcript !== "string" || !event.transcript.trim()) return
          const role = event.type === "response.output_audio_transcript.done" ? "assistant" : "user"
          const entry: Transcript = {
            id: `${role}:${event.item_id ?? event.event_id ?? "latest"}:${event.content_index ?? 0}`,
            role,
            text: event.transcript.length > 4000 ? `${event.transcript.slice(0, 4000)} [truncated]` : event.transcript,
          }
          setTranscripts((previous) => [...previous.filter((item) => item.id !== entry.id), entry].slice(-24))
        }
      }
      const offer = await peer.createOffer()
      if (!current()) return
      await peer.setLocalDescription(offer)
      if (!current()) return
      const sdp = peer.localDescription?.sdp
      if (!sdp) throw new Error("The browser did not create an SDP offer.")
      stage = "Voice session request failed"
      const answer = await api<{ sdp: string }>(azure ? "/realtime/azure" : "/realtime", {
        sdp, name: snapshot.name, spec: snapshot.spec, output: snapshot.output,
      }, "POST")
      if (!current()) return
      if (typeof answer?.sdp !== "string" || !answer.sdp.trim()) throw new Error("The server did not return an SDP answer.")
      stage = "WebRTC answer setup failed"
      await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp })
      if (!current()) return
      answerApplied = true
      ready()
    } catch (cause) {
      const name = cause instanceof Error ? cause.name : ""
      const detail = name === "NotAllowedError" || name === "SecurityError"
        ? "Microphone permission was denied or blocked. Allow microphone access in browser/site settings; embedded pages also need microphone permission from their host."
        : name === "NotFoundError"
          ? "No microphone was found. Connect a microphone and try again."
          : name === "NotReadableError" || name === "AbortError"
            ? "The microphone could not be opened. Check the device and whether another app is using it."
            : `${stage}: ${cause instanceof Error ? cause.message : String(cause)}`
      fail(detail)
    }
  }

  return <>
    <div className="chat-tools">
      <button type="button" className="mic-button" aria-expanded={open} aria-controls={id} aria-label={open ? `Close ${conversation} and stop microphone` : azure ? "Open Azure OpenAI Realtime voice conversation (mic button)" : "Open voice conversation"} onClick={() => {
        if (open) stop()
        setOpen(!open)
      }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" focusable="false"><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" /></svg>
        {open ? `Close ${azure ? "Azure " : ""}voice` : `${service} ${azure ? "mic" : "voice conversation"}`}
      </button>
    </div>
    <section id={id} className="realtime-panel" aria-labelledby={`${id}-heading`} hidden={!open}>
      <h2 id={`${id}-heading`}>{service} Realtime voice conversation</h2>
      <p className="hint" id={`${id}-privacy`}>Starting sends a snapshot of this file's name, current spec and available output to {service}. Your microphone transmits audio to {service} while connected, including while assistant audio plays. Stop or close this panel to turn it off. Context is refreshed only when starting a new voice session; text chat stays separate. Starting either provider stops the other voice session.</p>
      {!available && <p className="hint">{service} Realtime voice is not configured on the server. Text chat is independent.</p>}
      {unsupported && <p className="hint">{unsupported}</p>}
      <p role="status" aria-live="polite">{status}</p>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="chat-tools">
        {phase === "idle"
          ? <button type="button" className="mic-button" disabled={!available || !!unsupported} aria-describedby={`${id}-privacy`} onClick={() => void start()}>Start {conversation}</button>
          : <button type="button" className="mic-button" onClick={stop}>{phase === "connecting" ? `Cancel ${azure ? "Azure " : ""}connection` : `Stop ${conversation}`}</button>}
        {audioBlocked && <button type="button" onClick={() => void session.current?.play()}>Resume audio</button>}
      </div>
      {audioBlocked && <p className="hint" role="status">Assistant audio could not play automatically. Select Resume audio to hear it. Your microphone remains live while connected.</p>}
      <audio ref={audio} autoPlay />
      {!!transcripts.length && <div className="chat-messages" role="log" aria-label="Voice transcripts" aria-live="polite" aria-relevant="additions text">
        <p className="hint">Recent voice transcripts, when supplied by {service}. Transcription may be imperfect; only the latest 24 entries are kept.</p>
        {transcripts.map((entry) => <article className={`chat-message ${entry.role}`} key={entry.id}><h3>{entry.role === "user" ? "You" : "Voice assistant"}</h3><div>{entry.text}</div></article>)}
      </div>}
    </section>
  </>
}

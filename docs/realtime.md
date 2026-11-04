# OpenAI Realtime And Azure Voice

Voice is independent of text chat and inline completion. OpenAI retains its GA
unified WebRTC calls API with direct browser/provider media. Azure now uses explicit
Record/Send turns: the backend sends recorded audio to Whisper for STT, then its
transcript to gpt-audio-mini Chat Completions for a generated spoken answer.
Azure no longer uses Realtime, WebRTC, client secrets, or SDP negotiation.

## Conversation Language

OpenAI voice, Azure voice, and text chat send an English-only language policy in
their server-authored instructions. The assistant is instructed to answer only
in English, never follow language-switch requests from conversation or spec/log
context, and ask "Please repeat your request in English." for non-English or
mixed-language requests (also for unclear speech). English with any accent is
welcome. Code, filenames, proper names, and quoted source text remain data and
are explained in English; this is not an ASCII-only filter on specs or logs.
Inline completion and provider credentials/settings are unchanged.

This is model guidance, not a guaranteed input/output language filter. OpenAI
audio streams directly to the provider. Azure audio goes through the backend on
Send, and the final Whisper transcript becomes the current question; the server
does not validate its language or enforce the answer's language before playback.
Strict enforcement would require language validation and gating before response
generation and playback. Test non-English speech, mixed-language speech, noise,
and requests to change language with a live microphone before relying on it.

The backend sends instructions for each new OpenAI call, Azure answer, and
text-chat request; Azure CLI does not set a persistent deployment-wide policy.
Rebuild/restart the backend to apply instruction changes; existing OpenAI calls
keep their original instructions. OpenAI input transcription remains disabled.
Azure uses Whisper transcription without a forced language hint or translation.

## Setup

In session chat, select the mic button labeled **OpenAI voice conversation**, then
**Start voice conversation**. Allow microphone access and speak; automatic turn
detection requests a spoken response after you pause. **Stop voice conversation**
or closing the panel releases the microphone. If autoplay is blocked, select
**Resume audio**. OpenAI uses a fresh spec/log snapshot at connection time and
does not share history with text chat. Recent transcripts appear when supplied
by OpenAI; input transcription is not enabled by default.

Set `OPENAI_API_KEY` in the Rust server's environment and restart the server.
The key must have access to OpenAI Realtime models and an appropriately funded
project. Optionally set `OPENAI_REALTIME_MODEL`; the default is `gpt-realtime`.
No Azure variables are required for OpenAI voice. Do not put these credentials in
frontend environment variables, source code, or browser storage.

Configuration is read once at startup. An absent key disables OpenAI voice, even
if a model is set. A supplied empty/invalid key or invalid model fails startup with
a credential-free configuration error. A configured key is not a connectivity
or model-access health check. Existing Azure chat configuration is unchanged.

The authenticated `GET /api/config` response includes independent `realtime`
(OpenAI) and `azureVoice` (Azure) booleans alongside `execution`, `completion`,
and `chat`. It exposes no provider credentials, URLs, or model configuration.

Browser microphone access needs HTTPS or localhost, microphone permission, and
an explicit user action. Networks must permit WebRTC media connectivity to
OpenAI. The Rust server needs outbound HTTPS access to `api.openai.com:443`.
Realtime use incurs OpenAI charges. Limit access to trusted holders of the
application token; the concurrency limit is not a billing quota or rate limit.

### Azure Setup

Set all four variables in the **local Rust server's environment** or a private
server-side dotenv file, then restart the server and reload the browser:

```sh
AZURE_OPENAI_VOICE_ENDPOINT="https://YOUR-RESOURCE.openai.azure.com"
AZURE_OPENAI_VOICE_API_KEY="YOUR-AZURE-VOICE-KEY"
AZURE_OPENAI_WHISPER_DEPLOYMENT="spec-whisper"
AZURE_OPENAI_AUDIO_DEPLOYMENT="spec-audio-mini"
```

To use an existing private voice-only dotenv file without changing text settings,
launch from the repository root on the end user's machine:

```sh
SPEC_AZURE_VOICE_ENV_FILE="$HOME/.config/spec/azure-voice.env" ./run.sh --local
```

Use your actual existing file path; omit `--local` if you also want remote builds.
This exports the selector to the server without sourcing the file or changing
`SPEC_AI_ENV_FILE` or any text variables. Export `SPEC_AZURE_VOICE_ENV_FILE` in
the launch environment, not inside a dotenv file. An absolute path is recommended
because `run.sh` starts the server from `backend/`.

An explicit `SPEC_AZURE_VOICE_ENV_FILE` replaces the shared file for Azure voice
only; its missing values are not filled from the shared file. If unset, Azure
voice uses `SPEC_AI_ENV_FILE`, or the nearest `.env` in the server's current or
ancestor directories. Process exports of the four voice variables override file
values, including empty exports. Unset an unwanted export to use the file value.
These dedicated voice settings do not replace or modify text-chat settings;
leave the existing text endpoint, key, and deployment unchanged.

Browser and remote build environments are not automatically transferred to the
local Rust server. Configure the machine and process actually running that server;
never put secrets in the browser, frontend environment variables, or source code.

Replace placeholders with the resource's actual lowercase hostname and its
Whisper and audio model deployment names, not the text-chat deployment. The endpoint
must be a canonical HTTPS origin on `RESOURCE.openai.azure.com`, optionally ending in
one `/`. Credentials, explicit ports (including `:443`), paths, query strings,
fragments, noncanonical/normalized URLs, proxy hosts, and non-Azure hosts are
rejected. Sovereign-cloud and other hostname suffixes are not supported by this
allowlist. The key is nonempty printable ASCII without whitespace, at most 4096
bytes; each deployment is 1-128 ASCII letters/digits/`-_.`, excluding `.` and `..`.

All four absent disables Azure voice. Partial, empty, invalid, or non-UTF-8
Azure voice configuration, including an unreadable or malformed explicit voice
file, disables Azure voice only and emits a sanitized stderr warning without
printing values; it does not abort the text server. Shared text configuration
errors still fail startup. Fix the local voice settings, restart the server, and
reload the browser. There is no default Azure deployment and no fallback to
`OPENAI_API_KEY`, `OPENAI_REALTIME_MODEL`,
`AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `DEPLOYMENT_NAME`, or text API
version settings. OpenAI voice, Azure voice, and Azure text can be configured
independently or together. Capability booleans are not connectivity checks.

### Azure CLI Launcher

On the machine running the server, sign in with `az login` and select the intended
subscription with `az account set --subscription YOUR-SUBSCRIPTION`. From the
repository root, launch using existing Whisper and audio deployments:

```sh
bash scripts/azure-voice.bash RESOURCE_GROUP RESOURCE WHISPER_DEPLOYMENT AUDIO_DEPLOYMENT COMMAND [ARG...]
```

The launcher retrieves the resource's custom domain and key through Azure CLI,
and exports only `AZURE_OPENAI_VOICE_ENDPOINT`, `AZURE_OPENAI_VOICE_API_KEY`,
`AZURE_OPENAI_WHISPER_DEPLOYMENT`, and `AZURE_OPENAI_AUDIO_DEPLOYMENT` to the command it
starts. It does not write credentials to disk, print the key, change text
variables, rotate keys, or provision resources. The signed-in identity needs
permission to read the resource and list its keys. Azure public-cloud resources
with local API-key authentication enabled are required.

All four existing local voice exports take precedence without calling Azure.
Empty or partial exports are rejected rather than mixing credentials from
different resources. With no voice exports, an existing
`SPEC_AZURE_VOICE_ENV_FILE` takes precedence and is read by the server as usual.
An explicitly empty file selector is rejected; unset it or supply a file path.
Otherwise the CLI-derived exports override voice values in the shared dotenv
file. Text settings and `SPEC_AI_ENV_FILE` remain unchanged.

Provider-side provisioning alone cannot update an already-running local server.
Restart it through this launcher, reload the browser, and check authenticated
`GET /api/config` for `azureVoice: true`. Then test microphone audio; that
capability flag checks configuration only, not provider connectivity. Voice
usage is billed by Azure.

Launcher isolation tests (mock Azure CLI, no credentials or network required):
`node --test scripts/azure-voice.test.cjs`.

### Migration Status (2026-11-04)

Azure CLI successfully deployed these models on resource `spec-realtime-a8ba4251`,
resource group `founderies`, region `eastus2`:

| Deployment | Model | Version | SKU | Capacity |
| --- | --- | --- | --- | --- |
| `spec-whisper` | `whisper` | `001` | Standard | 3 |
| `spec-audio-mini` | `gpt-audio-mini` | `2025-12-15` | GlobalStandard | 1 |

The old `spec-voice` deployment was intentionally **not deleted**, to avoid
disrupting other clients. A live synthetic-audio check passed through the new Rust
endpoint, Whisper, and gpt-audio-mini, returning a valid spoken MP3 answer.
Provisioning has not restarted the running app. After stopping the existing app,
rebuild/relaunch from the repository root with the updated launcher:

```sh
bash scripts/azure-voice.bash founderies spec-realtime-a8ba4251 spec-whisper spec-audio-mini ./run.sh --local
```

Omit `--local` to retain remote builds. Reconnect using the new server token URL
and reload the UI. Update any selected private voice file to the four new names;
old `AZURE_OPENAI_REALTIME_*` and `SPEC_AZURE_REALTIME_ENV_FILE` settings are no
longer read. `/api/realtime/azure` and `azureRealtime` have been removed, not
aliased. Text settings and OpenAI `/api/realtime` remain unchanged.

### Using Azure Voice

In session chat, open **Azure mic**, select **Record question**, allow microphone
access, then select **Send recording**. Recording stays local until Send. The
microphone is released before context refresh, upload, generation, and playback.
At 60 seconds recording stops and waits for Send or Cancel; it never auto-sends.
Recordings over 4 MiB are discarded. The browser needs HTTPS/localhost and a
MediaRecorder supporting WebM, MP4, or WAV; the server needs outbound HTTPS to
the Azure resource, but Azure browser WebRTC connectivity is no longer required.

Use **Cancel recording**, **Cancel response**, **Stop audio**, or **Interrupt and
record question** deliberately. Background noise cannot interrupt playback because
the mic is off; speaking "stop" is not detected. This trades hands-free VAD and
streaming latency for explicit turns, with sequential transcription and answer
generation before playback. **Resume audio** recovers blocked autoplay. Closing
the panel or leaving the page releases resources; late results cannot revive a
cancelled turn. Cancelling a submitted request does not guarantee provider work
or charges stop.

Each Send refreshes spec/output context; refresh failure blocks submission rather
than silently using stale logs. Only the latest **four complete question/answer
pairs (eight messages)** are displayed and retained for continuity. Changing runs
clears Azure history. History is in browser memory, separate from text chat and
OpenAI; no audio history is sent with later questions. Starting either voice
provider stops the other in that window; merely opening a panel does not request
the mic or interrupt the other provider. Text drafts and Agent.md editing stay
separate. Azure usage is billed separately from OpenAI.

## API Contract

Both endpoints use the existing application authentication:

```http
Authorization: Bearer <Rust server access token>
Content-Type: application/json
```

### OpenAI Request

`POST /api/realtime` is unchanged:

```json
{
  "sdp": "v=0\r\n...browser audio SDP offer...",
  "name": "idea.md",
  "spec": "Current editor buffer, possibly unsaved",
  "output": {
    "id": "displayed-run-id",
    "status": "running",
    "output": "Displayed nohup/session output snapshot",
    "truncated": false
  }
}
```

All four top-level fields are required. `output` may be `null`; otherwise all
four nested fields are required. Unknown fields are rejected, including
endpoints, credentials, models, session settings, and tools. An empty spec or
log is allowed. The spec need not exist on disk.

Success is HTTP 200 with `Cache-Control: no-store` and JSON containing only:

```json
{"sdp": "v=0\r\n...provider SDP answer..."}
```

The client applies this as the peer connection's remote description with
`type: "answer"`. No ephemeral API key or provider call ID is returned.

### Azure Request

`POST /api/voice/azure` accepts all six required fields:

```json
{
  "audio": "<base64-encoded recording, not a data URL>",
  "format": "webm",
  "name": "idea.md",
  "spec": "Current editor buffer, possibly unsaved",
  "output": null,
  "messages": [
    {"role": "user", "content": "Earlier recognized question"},
    {"role": "assistant", "content": "Earlier spoken answer"}
  ]
}
```

`format` is `webm`, `mp4`, or `wav`. `output` uses the same required nested fields
as OpenAI above. `messages` may be empty; otherwise it must contain an even count
of at most eight messages, alternating user/assistant, starting with user.
Unknown fields are rejected at every level. Clients cannot supply a transcript,
system prompt, provider URL, credentials, models, voice settings, or tools.

Success is HTTP 200 with `Cache-Control: no-store`:

```json
{"transcript":"Recognized question","answer":"Generated spoken answer","audio":"<base64 MP3>","format":"mp3"}
```

The browser renders the text and plays an MP3 blob; no provider key or audio URL
is returned. The answer text is the generated audio's transcript.

## Provider Protocol

### OpenAI (Unchanged)

The server sends `POST https://api.openai.com/v1/realtime/calls` authenticated
with its standard `OPENAI_API_KEY`, not the application's access token. Its
multipart request contains `sdp` (`application/sdp`) and `session`
(`application/json`). Session settings include:

```json
{
  "type": "realtime",
  "model": "gpt-realtime",
  "instructions": "English-only language policy and read-only voice rules followed by a bounded JSON context snapshot",
  "output_modalities": ["audio"],
  "audio": {
    "input": {"turn_detection": {"type": "server_vad", "create_response": true, "interrupt_response": true}},
    "output": {"voice": "marin"}
  },
  "tools": [],
  "tool_choice": "none"
}
```

This is the GA unified calls flow, not the legacy beta `/realtime` exchange,
client-secret minting, or GPT-Live sessions API. No beta header is sent. OpenAI's
raw SDP response is validated and wrapped in the application's JSON response.

Verified against official OpenAI documentation on 2026-10-09:

- [Realtime WebRTC guide, unified interface](https://developers.openai.com/api/docs/guides/realtime-webrtc#connecting-using-the-unified-interface)
- [Create call API reference](https://developers.openai.com/api/reference/resources/realtime/subresources/calls/methods/create)

### Azure Whisper And Audio

The backend performs two non-streaming requests against the configured resource
origin, both with its sensitive `api-key` header, never the application token:

1. `POST /openai/deployments/{whisper}/audio/transcriptions?api-version=2024-06-01`
   sends multipart `file` (`recording.webm`, `.mp4`, or `.wav`, with matching MIME)
   and `response_format=verbose_json`. Whisper is **STT only**, not TTS. No spec,
   history, forced language, or Realtime noise-reduction settings are sent to STT.
2. `POST /openai/deployments/{audio}/chat/completions?api-version=2025-01-01-preview`
   sends `model` equal to the audio deployment, `modalities: ["text", "audio"]`,
   `audio: {"voice":"alloy","format":"mp3"}`, and `max_completion_tokens: 4096`.
   Messages are the server's system instructions, bounded context as a user
   message, complete prior exchanges, then the actual Whisper transcript as the
   final user question. The response must have exactly one choice, finish reason
   `stop`, and valid `message.audio.data` and `message.audio.transcript`.

`gpt-audio-mini` generates the answer and its spoken audio through **Chat
Completions**, not the `/audio/speech` TTS endpoint. A dedicated alternative such
as `gpt-4o-mini-tts` would require a different text-generation/TTS pipeline and is
not used here. There is no Realtime or text-provider fallback.

An empty transcript or an entirely silent segment result is rejected with 422
before answer generation. For supplied segments, every segment must have both
`no_speech_prob > 0.6` and `avg_logprob < -1.0` to trigger the silence rule (an
empty segment list also counts as silent). Missing metrics do not trigger it.
Individual segments are not dropped and thresholds are not raised to filter
quiet speech. This is a silence heuristic, not VAD, speaker isolation, an
interruption system, or a guarantee against hallucinated transcription.

### Azure Background Noise

The new Azure browser capture requests `echoCancellation` and `noiseSuppression`
as optional (`ideal`) preferences. Unsupported preferences do not prevent capture;
the actual processing depends on the browser/device. Automatic gain control is
left at the browser default, not disabled or boosted by the application.

The prior Azure Realtime path already enabled `near_field` noise reduction before
VAD; that completed change is historical, not a setting carried into Whisper.
The new path has no provider-side Realtime noise reduction or hands-free VAD.
Whisper does not identify the intended speaker: background conversations may be
transcribed during recording. No voiceprint enrollment or speaker verification is
implemented, and unchanged recognition accuracy cannot be guaranteed.

For a future Realtime alternative, supported controls include
`audio.input.noise_reduction` with `near_field` (close mic/headset) or `far_field`
(more distant microphone), server VAD `threshold`, `prefix_padding_ms`,
`silence_duration_ms`, and `interrupt_response`, or semantic VAD where supported
by the selected API/model. Noise reduction precedes VAD; raising thresholds can
miss quiet speech, and turn timing trades responsiveness against clipping or
premature answers. These are **Realtime controls, not implemented in the new
Azure path and not Whisper's own interruption system**. See
[Microsoft's Realtime reference](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/realtime-audio-reference).
OpenAI capture/session settings remain unchanged: server VAD with automatic
responses and spoken interruptions enabled, no explicit noise-reduction setting.

## Context And Limits

The instructions label spec/log content as untrusted, read-only data. They
distinguish intended behavior from execution evidence, explain spec completion
markers, and prohibit claims of edits, commands, builds, or independently
verified logs. No files or logs are fetched, written, or refreshed by these
endpoints. OpenAI's snapshot is fixed at call creation; start another call for new
context. Azure gets a fresh client snapshot per Send, not a live stream of edits
or logs. Prompt instructions are not a security boundary: neither voice path has
server-side tool handlers or write capabilities.

- OpenAI SDP offer and answer: at most 64 KiB UTF-8 each. Both must start with a `v=0`
  line and contain an `m=audio ` line; control characters except CR/LF/tab are
  rejected. This is a structural sanity check, not a complete SDP parser.
- Spec: at most 2 MiB UTF-8. Only the first 16 KiB, rounded down to a UTF-8
  boundary, is included in provider context.
- Displayed log: at most 256 KiB UTF-8. Only the last 16 KiB, rounded inward to
  a UTF-8 boundary, is included in provider context.
- Name: existing flat filename validation, maximum 180 bytes. Output ID/status:
  nonblank, no control characters, maximum 128/256 bytes respectively.
- Context snapshots disclose omitted spec-tail/log-head byte counts and preserve the
  client's `truncated` flag, including an aggregate `contextTruncated` flag.
- Azure input and output audio: at most 4 MiB decoded each; canonical standard
  base64 is bounded to `ceil(4 MiB / 3) * 4` bytes. Container signatures are checked
  (WebM, MP4, WAV input; MP3 output), not fully decoded by the backend. The browser
  has a 60-second recording timer; the API does not enforce decoded duration.
- Azure history: at most eight messages/four complete pairs, 16 KiB UTF-8 each.
  Transcript: at most 8 KiB; answer transcript: at most 16 KiB. These texts must
  be nonblank and reject control characters except CR/LF/tab.
- OpenAI raw JSON body: `(64 KiB + 2 MiB + 256 KiB) * 6 + 8192` bytes. Azure:
  `ceil(4 MiB / 3) * 4 + (2 MiB + 256 KiB + 8 * 16 KiB) * 6 + 8192` bytes.
  These allow context/history JSON escaping; decoded field limits still apply.
- Four concurrent OpenAI handshakes and, independently, four Azure turns per
  server process, shared across App clones and independent of text chat. Azure
  holds one slot across decoding, both provider requests, and response reads;
  slots release on completion, failure, or handler cancellation. OpenAI slots
  cover signaling, not active WebRTC calls; Azure slots do not cover playback.
- Provider connect timeout: 5 seconds. OpenAI request/upload/response timeout:
  30 seconds. Azure has one 120-second deadline spanning decoding, both requests,
  and reads, not 120 seconds per stage. OpenAI SDP responses stop above 64 KiB;
  Azure STT JSON stops above 1 MiB and audio-completion JSON above 8 MiB, including
  chunked responses. Malformed, truncated, or oversized provider output fails.
- HTTPS-only fixed OpenAI URL or trusted configured Azure origin, no client
  endpoint overrides, no redirects,
  and no application retries. Errors do not expose provider bodies, headers,
  URLs, or keys. Failed/cancelled requests can still incur provider costs;
  clients should not automatically retry in a loop.

Application errors use `{"error":"..."}`: 400 invalid fields, SDP, base64, audio
signature, or history; 401 missing/wrong application token; 413 oversized payload;
422 Azure no speech recognized; 429 concurrency limit; 503 voice not configured;
502 provider rejection, transport failure, malformed/oversized output, or incomplete
audio answer; and 504 provider timeout. Azure provider failures use the sanitized
messages `Azure voice provider request failed` or `Azure voice provider timed out`.
Axum's JSON extractor returns its standard errors for malformed JSON (400), schema
violations (422), and wrong content type (415); these are not necessarily JSON.

## Browser Security

The served UI's CSP keeps `connect-src 'self'` for same-origin API requests and
`media-src 'self' blob:` for OpenAI WebRTC audio and Azure MP3 blob playback. It
does not add provider HTTP origins to `connect-src`. OpenAI WebRTC media/data
channels are separate from same-origin signaling. Azure recording uploads and
audio responses pass through the authenticated backend, with no direct provider
browser connection. Closing/stopping releases media; Azure blob URLs are revoked.

The OpenAI browser has a direct Realtime data channel and can send session events.
Initial instructions are not immutable provider-side policy, and the backend
does not implement sideband session enforcement or call termination. Never
attach privileged tools based on the assumption that these instructions cannot
be changed. Only context intentionally supplied by the client is sent to
the selected provider; its data handling and retention policies apply. The selected
provider receives the bounded spec and displayed-output snapshot, potentially
including unsaved text and sensitive logs. OpenAI also receives microphone audio
over WebRTC; Azure receives the submitted recording for STT and transcript/history
for answer generation. The backend processes Azure audio/transcripts in memory
but does not persist them. The browser keeps recent Azure text history in memory.
Keys remain backend-side and are never returned or logged; provider error bodies
and headers are never forwarded. Do not place backend secrets in prompts. Only
grant the application token to trusted users: concurrency is not a billing quota
or rate limit, and client-supplied history/context is not verified evidence.

## Verification

Run from `backend/`:

```sh
cargo fmt --check
cargo test --locked
cargo clippy --all-targets --locked -- -D warnings
```

`src/realtime_tests.rs` uses isolated loopback mock providers, not real keys or
billable API calls. It covers multipart/auth/session payloads, independent
configuration, read-only snapshots, UTF-8 truncation, validation/body bounds,
shared concurrency, sanitized failures, redirect refusal, chunked response
bounds, timeouts, and transport failures. Existing auth and config fixtures are
adapted. A live browser/microphone smoke test with funded provider access is
still required to verify audio and actual model availability end to end.

`src/azure_voice_tests.rs` uses mock providers for the Whisper/audio protocol,
independent configuration, origin validation, authentication/capabilities, bounded
context/history/audio, silence handling, concurrency/cancellation, sanitized
failures, response bounds, redirects, and the combined deadline. These checks are
not live model-access, latency, or recognition-accuracy evidence.

From `frontend/`, run `bun run build`, `bun run test:unit`, and
`bun run test:e2e` (build the debug Rust server first with `cargo build --locked`).
`e2e/realtime.spec.ts` mocks microphone/MediaRecorder, WebRTC, provider responses,
and API requests to exercise independent panels, context/history, explicit Azure
Send, mic-off playback, interruption/cancellation, recovery, and OpenAI behavior.
Run `node --test scripts/azure-voice.test.cjs` from the repository root for isolated
launcher tests.

The billable live smoke check generates a synthetic WAV question, starts an
isolated temporary debug server, submits that recording to `/api/voice/azure`,
and verifies the transcription, answer, and MP3 output. It leaves the existing
server alone and keeps keys and audio in memory. Build the debug backend first,
then run from the repository root:

```sh
bash scripts/azure-voice.bash founderies spec-realtime-a8ba4251 spec-whisper spec-audio-mini node scripts/azure-voice-smoke.cjs
```

On 2026-11-04 this returned transcript `What is 2 plus 2?`, answer
`2 plus 2 is 4.`, and 16,869 bytes of MP3 audio. Backend tests (234), frontend unit
tests (174), browser tests (266), and launcher tests (29) passed; the corrected
history contract was rechecked with all 46 voice browser tests.

Real-microphone acoustic validation is still pending, and the running service has
not been restarted for this migration. With the same device, mic distance, and playback volume,
check quiet/normal speech, initial-word clipping, silence, fans/typing, and nearby
conversation. Confirm no upload before Send, mic-off generation/playback, deliberate
button interruption, and autoplay recovery. Measure Send-to-playback latency and
recognition errors with headphones and speakers; do not infer intended-speaker
isolation or unchanged accuracy from a successful turn or mock test.

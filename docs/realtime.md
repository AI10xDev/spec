# OpenAI And Azure Realtime Voice

Voice signaling is independent of the existing Azure-backed chatbot and inline
completion. OpenAI retains its GA unified WebRTC calls API; Azure OpenAI has a
separate GA client-secret and raw-SDP exchange. The backend does not proxy
microphone/audio traffic or rebuild the chatbot.

## Setup

In session chat, select the mic button labeled **OpenAI voice conversation**, then
**Start voice conversation**. Allow microphone access and speak; automatic turn
detection requests a spoken response after you pause. **Stop voice conversation**
or closing the panel releases the microphone. If autoplay is blocked, select
**Resume audio**. Voice uses a fresh spec/log snapshot at connection time and
does not share history with text chat. Recent transcripts appear when supplied
by OpenAI; input transcription is not enabled by default.

Set `OPENAI_API_KEY` in the Rust server's environment and restart the server.
The key must have access to OpenAI Realtime models and an appropriately funded
project. Optionally set `OPENAI_REALTIME_MODEL`; the default is `gpt-realtime`.
No Azure variables are required for OpenAI voice. Do not put these credentials in
frontend environment variables, source code, or browser storage.

Configuration is read once at startup. An absent key disables voice, even if a
model is set. A supplied empty/invalid key or invalid model fails startup with
a credential-free configuration error. A configured key is not a connectivity
or model-access health check. Existing Azure chat configuration is unchanged.

The authenticated `GET /api/config` response includes independent `realtime`
(OpenAI) and `azureRealtime` (Azure) booleans alongside `execution`, `completion`,
and `chat`. It exposes no provider
credentials, URLs, or model configuration.

Browser microphone access needs HTTPS or localhost, microphone permission, and
an explicit user action. Networks must permit WebRTC media connectivity to
OpenAI. The Rust server needs outbound HTTPS access to `api.openai.com:443`.
Realtime use incurs OpenAI charges. Limit access to trusted holders of the
application token; the concurrency limit is not a billing quota or rate limit.

### Azure Setup

Set all three variables in the Rust server's environment and restart:

```sh
export AZURE_OPENAI_REALTIME_ENDPOINT="https://YOUR-RESOURCE.openai.azure.com"
export AZURE_OPENAI_REALTIME_API_KEY="YOUR-AZURE-REALTIME-KEY"
export AZURE_OPENAI_REALTIME_DEPLOYMENT="YOUR-REALTIME-DEPLOYMENT"
```

Replace placeholders with the resource's actual lowercase hostname and a deployed
Realtime model's deployment name, not the text-chat deployment. The endpoint must
be a canonical HTTPS origin on `RESOURCE.openai.azure.com`, optionally ending in
one `/`. Credentials, explicit ports (including `:443`), paths, query strings,
fragments, noncanonical/normalized URLs, proxy hosts, and non-Azure hosts are
rejected. Sovereign-cloud and other hostname suffixes are not supported by this
allowlist. The key is nonempty printable ASCII without whitespace, at most 4096
bytes; the deployment is 1-128 ASCII letters/digits/`-_.`, excluding `.` and `..`.

All three absent disables Azure voice. Partial, empty, invalid, or non-UTF-8
configuration fails startup without printing values. There is no default Azure
deployment and no fallback to `OPENAI_API_KEY`, `OPENAI_REALTIME_MODEL`,
`AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `DEPLOYMENT_NAME`, or text API
version settings. OpenAI voice, Azure voice, and Azure text can be configured
independently or together. Capability booleans are not connectivity checks.

In session chat, select the separate **Azure OpenAI mic** button, then **Start
Azure voice conversation**. Its panel is labeled **Azure OpenAI Realtime voice
conversation**. Starting is enabled by `azureRealtime` and uses
`/api/realtime/azure`; the existing OpenAI mic button continues to use `realtime`
and `/api/realtime`. Both require an explicit start action and microphone consent,
and display the selected provider. Starting one provider stops any connecting or
connected voice session for the other provider in this chat window. Merely opening
a panel does not request microphone access or interrupt the other provider.
Stop or close the Azure panel to release its microphone; **Resume audio** recovers
blocked playback. Text drafts, text-chat history, and Agent.md editing stay separate.
The Azure resource needs Realtime availability/quota in a supported region;
the server needs outbound HTTPS to that resource and the browser needs WebRTC
connectivity to Azure. Azure usage is billed separately from OpenAI.

## API Contract

`POST /api/realtime` and `POST /api/realtime/azure` use identical JSON contracts
and the existing application authentication:

```http
Authorization: Bearer <Rust server access token>
Content-Type: application/json
```

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
  "instructions": "Read-only voice rules followed by a bounded JSON context snapshot",
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

### Azure GA

The backend performs both requests against the configured resource origin:

1. `POST /openai/v1/realtime/client_secrets` with `api-key: <Azure key>` and
   `Content-Type: application/json`. The body is `{"session": {...}}`, using
   exactly the session settings above with `model` set to the Azure deployment.
   The response must contain a top-level nonempty string `value` (the ephemeral
   token); other response metadata is ignored. No OpenAI/application bearer
   credential is sent on this request.
2. `POST /openai/v1/realtime/calls` with `Authorization: Bearer <ephemeral token>`
   and `Content-Type: application/sdp`. The body is the raw offer, **not
   multipart**. The Azure API key is not sent on this request. The raw answer
   passes the same bounded SDP validation as OpenAI and becomes `{"sdp":"..."}`.

Neither request adds `api-version`, a beta header, or `webrtcfilter=on`. In
particular, filtering would suppress the `session.created` event that the
frontend uses for readiness. No legacy preview regional endpoint is used.
Resource keys and ephemeral tokens stay backend-side; neither is returned to
the browser, cached, persisted, or logged. Credential headers are marked
sensitive and provider bodies/headers/errors are never forwarded.

Verified against [Microsoft's GA WebRTC guide](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/realtime-audio-webrtc?view=foundry-classic)
on 2026-10-09, including its backend-proxied raw-SDP negotiation example.

## Context And Limits

The instructions label spec/log content as untrusted, read-only data. They
distinguish intended behavior from execution evidence, explain spec completion
markers, and prohibit claims of edits, commands, builds, or independently
verified logs. No files or logs are fetched, written, or refreshed by these
endpoints. The snapshot is fixed at call creation; start another call to supply
new context. Prompt instructions are not a security boundary: there are no
server-side tool handlers or write capabilities attached to the voice session.

- SDP offer and answer: at most 64 KiB UTF-8 each. Both must start with a `v=0`
  line and contain an `m=audio ` line; control characters except CR/LF/tab are
  rejected. This is a structural sanity check, not a complete SDP parser.
- Spec: at most 2 MiB UTF-8. Only the first 16 KiB, rounded down to a UTF-8
  boundary, is included in instructions.
- Displayed log: at most 256 KiB UTF-8. Only the last 16 KiB, rounded inward to
  a UTF-8 boundary, is included in instructions.
- Name: existing flat filename validation, maximum 180 bytes. Output ID/status:
  nonblank, no control characters, maximum 128/256 bytes respectively.
- Instructions disclose omitted spec-tail/log-head byte counts and preserve the
  client's `truncated` flag, including an aggregate `contextTruncated` flag.
- Raw JSON body: `(64 KiB + 2 MiB + 256 KiB) * 6 + 8192` bytes to allow JSON
  escaping. Decoded field limits still apply.
- Four concurrent handshakes **per voice provider** per server process, shared
  across App clones and independent of chat and the other voice provider.
  Azure holds one slot across both requests. Slots cover complete response reads and
  are released on success, failure, or request cancellation. They do not limit
  active WebRTC conversations after signaling finishes.
- Provider connect timeout: 5 seconds. Total request/upload/response timeout:
  30 seconds. Azure has one 30-second deadline spanning both requests and reads,
  not 30 seconds per stage. SDP responses stop above 64 KiB; Azure client-secret
  JSON stops above 512 KiB, including for chunked bodies. Azure echoes the session:
  its 32 KiB of context can expand to 224 KiB through nested JSON escaping, with
  the remaining budget allowing the fixed prompt, session fields, and metadata.
  Ephemeral tokens remain at most 4096 printable ASCII bytes without whitespace.
- HTTPS-only fixed OpenAI URL or trusted configured Azure origin, no client
  endpoint overrides, no redirects,
  and no application retries. Errors do not expose provider bodies, headers,
  URLs, or keys. Failed handshakes can still have created a provider session;
  clients should not automatically retry in a loop.

Application errors use `{"error":"..."}`: 400 invalid fields/SDP, 401 missing
or wrong application token, 413 oversized payload, 429 handshake concurrency
limit, 503 voice not configured, 502 provider rejection/transport/malformed or
oversized answer or client-secret response, and 504 provider timeout. Axum's JSON extractor returns its
standard errors for malformed JSON (400), schema violations (422), and wrong
content type (415); these extractor errors are not necessarily JSON.

## Browser Security

The served UI's CSP keeps `connect-src 'self'` for same-origin signaling and
adds `media-src 'self' blob:` for remote WebRTC audio attached via `srcObject`
(including browser blob-backed media behavior). It does not add an OpenAI HTTP
or Azure HTTP origin to `connect-src`. WebRTC media/data channels are separate from the
same-origin HTTP signaling request; close the peer connection and stop local
microphone tracks when the user ends the conversation.

The browser has a direct Realtime data channel and can send session events.
Initial instructions are not immutable provider-side policy, and the backend
does not implement sideband session enforcement or call termination. Never
attach privileged tools based on the assumption that these instructions cannot
be changed. Only context intentionally supplied by the client is sent to
the selected provider; its data handling and retention policies apply. The selected
provider receives the bounded spec and displayed-output snapshot, potentially
including unsaved text and sensitive logs, plus microphone audio over WebRTC.
The backend does not record audio or transcripts. Azure event filtering is off,
so session instructions/context can also be visible to the browser over the
data channel; do not place backend secrets in prompts.

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

`src/azure_realtime_tests.rs` covers the two-stage GA protocol, credential
separation, independent environment configuration in isolated subprocesses,
trusted-origin validation, route authentication/capabilities, input/body limits,
concurrency/cancellation, both-stage sanitized failures and response bounds,
redirect refusal, transport failure, and the combined handshake deadline.

From `frontend/`, run `bun run build`, `bun run test:unit`, and
`bun run test:e2e` (build the debug Rust server first with `cargo build --locked`).
`e2e/realtime.spec.ts` mocks microphone access, WebRTC, provider events, and signaling
to cover independent provider availability, authenticated Azure routing, fresh
context, readiness, audio playback/recovery, transcripts, provider switching,
cancellation races, error cleanup, page hide, and narrow-screen layout alongside
the existing OpenAI tests. These mocks do not establish a live provider connection.

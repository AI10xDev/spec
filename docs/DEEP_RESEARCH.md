# Deep research with Exa

Use **Deep research**, beside the editor's **Saved / Unsaved / Editor** badge.
It works without an open file, SSH, Azure, or a text-model deployment. Opening the
dialog checks configuration only. Enter a question, review the privacy/billing
disclosure, then explicitly select **Start research**.

**Use current editor text** copies the current buffer into the visible question;
it does not send it. Without an open tab this action is disabled. Oversized text
is rejected visibly, not truncated. Neither filenames, logs, nor build history
are included automatically. Remove secrets and private data before submission.

## Configuration

Set `EXA_API_KEY` privately in the Rust server's environment, or in the shared
`.env` found from its working directory. `SPEC_AI_ENV_FILE` selects an explicit
shared dotenv file. Exports override file values, including an empty export
(which disables research). Restart the server after changes. Never put this key
in frontend variables, source control, a spec, or the research question.

Missing, empty, or invalid Exa keys disable research only. The status endpoint
provides setup guidance without exposing credentials. Existing shared dotenv
syntax/startup rules for other providers remain unchanged: a malformed shared
file can still prevent startup through those providers. Fix the shared file's
syntax rather than placing secrets in the browser. Configuration presence does
not prove Exa account access, credit availability, or provider health.

## Provider and limits

The backend makes one `POST https://api.exa.ai/search` per explicit submission,
with `type: "deep"`, `numResults: 10`, and a four-property `outputSchema`:
`title`, `summary`, `findings` (string array), `limitations` (string array).
There is no second model, custom agent loop, automatic retry, or content fetch
from returned source URLs. Exa may perform multiple searches internally;
`numResults` is not a limit on that internal work or a spending cap.

- 8 KiB UTF-8 question, NUL-free and nonempty; 64 KiB encoded JSON body.
- 90-second total wait, 10-second connect timeout.
- One active request per server, independent of chat and build concurrency.
- 1 MiB upstream response, counted while reading even without Content-Length.
- 64 KiB serialized generated report; at most 20 findings, 20 limitations,
  32 unique sources, 128 grounding entries and 128 citations per entry.
- HTTPS-only production transport, fixed endpoint, no redirects or retries;
  API key headers are sensitive. Local provider injection is compiled only in tests.

Queries incur Exa charges according to the provider's current account/pricing.
See [Exa pricing](https://exa.ai/docs/admin/pricing.md) rather than assuming a
fixed price. Timeout, network failure, or **Stop waiting & close** does not
prove the provider stopped or that no charge occurred. The browser aborts its
local wait on close. If the server continues its request, its slot remains
occupied until completion/timeout. Results from a closed dialog are discarded.
A subsequent submission is a new, potentially billed request, not recovery.

## Results, provenance, and privacy

Reports are read-only plain text with clickable citations and **Download
Markdown**. They are generated research, not implementation or verified test
evidence. Exa field-level grounding is provider-supplied provenance, not
independent verification. Fields without usable grounding are labelled;
search results alone do not establish claim support. Missing sources and
omitted unsafe URLs/invalid citation paths are disclosed. Missing or malformed
synthesis and oversized responses fail rather than returning a truncated report.

Only absolute HTTP(S) source links without credentials are accepted. Spec does
not fetch them. Following a link navigates to that third party. Provider text
is escaped, never rendered as raw HTML, loaded as remote images, or executed as
tools. Markdown export escapes report text and includes provenance warnings.

Research does not save or modify specs, completion markers, dirty buffers,
selection, output associations, build approvals, or jobs. Ordinary editor
autosave and existing already-authorized workflows remain independent. There is
no persistent research history or durable background job. Download before
closing; reports are held only in memory. Spec does not log questions or raw
upstream errors. Exa receives the submitted question and has its own data policy.

## API contract

Both routes require the existing Spec bearer token and use `Cache-Control:
no-store`.

- `GET /api/research`: `{ configured, maxQueryBytes, timeoutSeconds, message }`.
- `POST /api/research`: exactly `{ "query": "..." }`; unknown fields rejected.
- Success: `{ report: { title, summary, findings, limitations }, sources:
  [{ id, url, title }], grounding: { "findings[0]": [1], ... }, warnings: [...] }`.
  Source IDs are one-based and deduplicated by normalized URL. Grounding accepts
  only `title`, `summary`, and actual `findings[i]`/`limitations[i]` fields.
  Confidence values are not presented as verified probabilities.
- 400 invalid question; 413 body too large; 422 malformed schema; 503 research
  unconfigured; 429 local slot occupied; 504 timeout; 502 provider/network or
  invalid/oversized response. Provider authentication, credits, permissions and
  rate limits have distinct sanitized messages, not raw upstream bodies.

## Verification

Mock-provider tests live in `backend/src/research_tests.rs`; process-level
configuration tests in `backend/tests/research_config.rs`; export/byte/link tests
in `frontend/src/deep-research-export.test.tsx`; browser integration tests in
`frontend/e2e/deep-research.spec.ts`. Mocks are not real Exa accuracy evidence.

Official contract references: [Deep Search](https://exa.ai/docs/search/deep-search.md)
and [OpenAPI](https://exa.ai/docs/exa-spec.yaml). Live compatibility still requires
a privately configured key and an explicitly approved public, non-sensitive
question. Submit once, inspect synthesis/grounding and latency, and check actual
provider usage. Do not publish credentials or private queries. No live smoke
test is implied by passing mock tests.

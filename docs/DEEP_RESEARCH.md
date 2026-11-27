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

Open **Settings → Exa Deep Search** for the independent research configuration.
Exa Deep Search researches a question through multiple web searches and returns
a synthesized answer with source citations. Saving settings makes no provider
request, connectivity check or paid query. “Configured” only means a key is
present; it does not prove account access, credits or provider health.

- **Exa API key**: enter a new server-held key to add/replace the saved override.
  Blank retains the saved override. **Remove saved key** removes only that
  override and returns to the startup environment fallback, if any. It retains
  saved preferences and discards unsaved Exa form edits.
- **Enable Deep Search**: on by default. Off blocks future submissions even if a
  key is present. It does not revoke keys or cancel already-submitted work.
- **Returned pages**: integer 1–10, default 10. This is an application limit,
  not Exa's maximum or a spending cap. Exa may return fewer pages.
- **Source filter**: Any domain (default), Include domains, or Exclude domains.
  Include/exclude needs up to 20 distinct plain dotted DNS names. Commas or
  whitespace separate names in the form; names are lowercased and deduplicated.
  ASCII/punycode only, 253 bytes per name, 1–63 per label; no URLs, IP addresses,
  ports, paths, wildcards, empty labels or leading/trailing hyphens. This is
  deliberately narrower than Exa's filter syntax. Include/exclude cannot be
  combined. Filters can reduce available evidence; no DNS lookup is made on save.
- **Reset Exa settings**: confirmation clears all saved Exa preferences and key
  overrides, restoring defaults and the startup environment key. It neither
  disables a remaining environment key nor changes model/storage settings.

Key precedence: **saved Exa override → exported `EXA_API_KEY` → shared dotenv**.
`SPEC_AI_ENV_FILE` selects an explicit shared dotenv file; otherwise the normal
shared `.env` lookup applies. An empty export suppresses dotenv fallback, but
not a saved override. Preference-only saves never copy an environment key to
disk. UI changes apply immediately to future requests; actual environment/dotenv
changes require a server restart. Existing malformed shared-dotenv startup rules
for other providers remain unchanged.

Settings are shared server-wide by all authenticated browsers. The last successful
save wins. Each submission captures one immutable key/preferences snapshot;
in-flight requests retain their original snapshot. One concurrency slot is shared
across key rotations, reset and disable/re-enable. The research dialog shows
preferences loaded when opened, not a per-request privacy guarantee: another
browser may change them before submission. Reload settings after an uncertain
save before retrying. Closing the browser does not cancel a server-side save.

Keys are never returned (not even partially) or stored in browser storage. Entered
keys are cleared after successful save/removal/reset or leaving Settings. State
is stored in `profile.json.research.json`, a sibling of the AI settings file
(`SPEC_SETTINGS_FILE` if overridden), **outside workspace and UI served roots**.
It reuses private-file validation, 0700 directory / 0600 file permissions, bounded
loads and atomic replacement. This is restricted filesystem storage, **not
encryption at rest**. Only successfully persisted candidates become active.
No `.env`, model profile, execution handoff or spec is modified.

Missing Exa storage uses defaults and environment fallback. Unsafe or malformed
Exa storage disables research and rejects all Exa settings writes, including
reset, rather than silently selecting another billable key. Other workspace
features remain available. An operator must stop the server, inspect the private
sibling's ownership, permissions and file type (no symlinks or hard links), repair
its valid JSON or deliberately remove only that Exa sibling, then restart.
Removing it restores environment fallback; clear the environment key too if the
intent is no research. Never paste keys, file contents or private paths into logs,
specs or feedback. Unrelated AI/storage private-file failures retain their own
startup behavior.

## Provider and limits

The backend makes one `POST https://api.exa.ai/search` per explicit submission,
with `type: "deep"`, saved `numResults` (default 10), at most one of
`includeDomains` / `excludeDomains`, and a four-property `outputSchema`:
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
upstream errors. Exa receives the submitted question and configured search filters and has its
own data policy. No editor content is sent unless explicitly copied into the
question and submitted.

## API contract

All research and Exa settings routes require the existing Spec bearer token
(server-wide authorization, not a new administrator role) and use `Cache-Control:
no-store`.

- `GET /api/research`: `{ configured, maxQueryBytes, timeoutSeconds, message, preferences }`.
  `configured` means enabled and key present; preferences are null on storage failure.
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

### Exa settings API

- `GET /api/settings/research`: redacted `{ preferences, hasApiKey, hasSavedKey,
  keySource, preferenceSource }`. `keySource` is `settings`, `environment` or
  `none`; `preferenceSource` is `settings` or `defaults`.
- `PUT /api/settings/research`: complete `preferences` plus optional `apiKey`.
  Omission retains the saved override, nonempty replaces it, `""` removes it.
  `null`, non-string keys, unknown fields and malformed preferences are rejected.
- Preferences: `{ "enabled": true, "numResults": 10, "domainMode": "any",
  "domains": [] }`. Modes are `any`, `include`, `exclude`; Any requires an empty
  array. Domain limits and normalization above are also enforced server-side.
- `DELETE /api/settings/research`: reset Exa only; UI sends `{}`.
- 16 KiB JSON body limit; keys at most 4096 ASCII graphic bytes (no whitespace or
  controls). Static errors never echo submitted values. Unsafe/malformed private
  storage and persistence failures return 503 without publishing candidate state.

## Verification

Mock-provider tests live in `backend/src/research_tests.rs`; process-level
configuration/restart tests in `backend/tests/research_config.rs`; private settings
tests in `backend/src/research_settings_tests.rs`; export/byte/link tests
in `frontend/src/deep-research-export.test.tsx`; browser integration tests in
`frontend/e2e/deep-research.spec.ts` and `frontend/e2e/settings.spec.ts`; domain-form
tests in `frontend/src/exa-settings.test.tsx`. Mocks are not real Exa accuracy
evidence. See [fresh Settings validation](EXA_SETTINGS_VALIDATION.md).

Official contract references: [Deep Search](https://exa.ai/docs/search/deep-search.md)
and [OpenAPI](https://exa.ai/docs/exa-spec.yaml). Live compatibility still requires
a privately configured key and an explicitly approved public, non-sensitive
question. Submit once, inspect synthesis/grounding and latency, and check actual
provider usage. Do not publish credentials or private queries. No live smoke
test is implied by passing mock tests.

# Feature Review Reports

Choose **Feature review** beside **Performance output**. Enter the public GitHub
repository URL, optionally request an illustration, then choose **Generate feature
report**. Competitors are discovered automatically; there is no manual competitor
entry. The configured completion provider in Settings (or the server's
text-provider environment) explores competitors and writes the review. This can
incur text and image provider charges and take up to six minutes, including
discovery and request overhead. It does not launch, save, cancel, or continue a
build or Performance run.

Configure the completion provider before generating a report. The authenticated
`POST /api/feature-review` request accepts exactly `{repositoryUrl, illustrate}`:
a public GitHub repository URL and an illustration boolean. Image configuration
is separate and optional; no manually supplied competitor URLs are accepted.

The dialog presents a concise feature summary, findings, supported strengths,
competitor comparison tables, limitations, source citations and a workflow.
**Download PDF** creates a paginated PDF directly, without a print dialog.
**Download .md** creates a self-contained Markdown report. Both contain the same
report content, source revisions, warnings, diagrams and optional illustration.
Download before closing: results are held in the browser, not retained on the
server. Closing an in-flight request cannot guarantee cancellation of provider
work or charges. Failed requests can be retried; there is no automatic paid retry.

## Research Scope

- Supports `https://github.com/owner/repository` and the `.git` suffix. Other Git
  hosts, private repositories, credential-bearing URLs, subpaths, query strings,
  fragments and redirects are rejected.
- Fetches current public repository metadata, resolves the default branch through
  a lightweight Git ref, and reads the primary README at that commit. The configured
  completion provider's explorer forms up to two GitHub search queries from this
  evidence, fetches up to five results per query, and selects one to three relevant
  repositories from those results. The primary repository, forks, archived
  repositories, invalid candidates and duplicates are excluded. Selected
  competitors' READMEs are fetched at pinned commits before report generation.
  It does not crawl linked documentation, execute code, clone repositories or run
  their tests.
- Each README must be at most 128 KiB; the first 24 KiB is sent to the model.
  Truncation is disclosed. Metadata is current at fetch time, not historical
  commit metadata. GitHub rate limits or unavailable evidence fail the request
  rather than inventing sources.
- Discovery is bounded, not an exhaustive market survey. Report warnings include
  discovery limitations, selection reasons and search URLs. If no suitable
  candidates are found, the request fails with an actionable error rather than
  inventing competitors or asking for manual entry. Follow the error guidance
  before retrying; a more descriptive public repository README may help discovery.
  All comparisons are documentation-based, not independent benchmarks. Unknown
  evidence is not proof that a feature is absent. Review AI-generated claims
  against the cited sources before relying on them.
- Repository text is treated as untrusted data. Model results must satisfy a
  bounded schema with valid citation IDs before they are displayed. Markdown
  escapes model-controlled markup, and the UI renders it as plain text.
- The authenticated endpoint limits concurrent reviews to two and bounds
  network responses and generation time. It does not use repository-provided
  endpoints or retrieve remote illustration URLs.

## Azure GPT-image

Set these variables in the **local backend process environment** before
starting/restarting Spec. They are not read from the AI dotenv file or Settings
UI. Keep the key in your existing secret-management mechanism, never in browser
code, reports, shell transcripts or committed configuration.

| Variable | Value |
| --- | --- |
| `SPEC_REVIEW_IMAGE_ENDPOINT` | HTTPS Azure resource root, such as `https://YOUR-RESOURCE.openai.azure.com` |
| `SPEC_REVIEW_IMAGE_DEPLOYMENT` | Your deployed GPT-image model's deployment name |
| `SPEC_REVIEW_IMAGE_API_KEY` | Server-side API key for that resource |

The backend calls the deployment-scoped Azure images generation API using
`api-version=2025-04-01-preview`, PNG output and a 1024 x 1024 workflow prompt.
It accepts bounded base64 PNG results only. The status indicator confirms valid
configuration shape, not successful authorization or model availability.

Use Azure CLI to discover resources and model deployments without printing keys:

```sh
az account show --query '{name:name,state:state}' -o json
az cognitiveservices account list --query '[].{name:name,resourceGroup:resourceGroup,kind:kind,endpoint:properties.endpoint}' -o json
az cognitiveservices account deployment list -g YOUR_RESOURCE_GROUP -n YOUR_RESOURCE --query '[].{name:name,model:properties.model,state:properties.provisioningState}' -o json
```

Discovery on November 7, 2026 used Azure CLI 2.89.1. The one enabled subscription
exposed `admin-8357-resource` with `gpt-6-astra` and `gpt-6-sol`, and
`spec-realtime-a8ba4251` with `spec-voice`, `spec-whisper` and
`spec-audio-mini`. **Neither account had a GPT-image deployment.** No resource,
deployment or agent was created, and no keys were retrieved. No GPT-image agent
configuration or image-generation success was established by this discovery.
An authorized GPT-image deployment and its server configuration remain required
for live illustrations; deployment provisioning is a separate operator action.
A repeat Azure CLI deployment-list check during the automatic-discovery update
again found no GPT-image deployments in either account. Live image generation
remains unavailable with these resources.

If image configuration is missing or generation fails, the report remains
downloadable and explicitly says no AI image was generated. Fixed vector/Mermaid
workflow and evidence diagrams remain available. These are not represented as
GPT-image output. Generated illustrations are illustrative, not evidence.
The fixed workflow explicitly shows primary evidence review, automatic competitor
discovery, pinned README comparison and report export.

## Export Notes

PDF uses built-in fonts. Non-ASCII characters are represented by explicit Unicode
code-point labels with a warning, rather than silently producing broken glyphs.
Markdown preserves Unicode. Markdown includes Mermaid diagrams and embeds the
PNG as a data URL; renderer support varies. The PDF includes actual vector
diagrams and embeds a valid generated PNG without external assets.

## Verification

The feature has offline Rust tests for authorization, strict URL and schema
validation, Git-ref lookup, network bounds and Azure request/failure handling.
Frontend tests cover exports, escaping, large PNGs, pagination, modal behavior,
responsive layouts, actual downloads and image rendering under the server CSP.
These use fixtures: they do not establish live GitHub/provider end-to-end success
or GPT-image deployment availability.
The automatic-discovery update passed 306 backend tests (including 14 feature
review tests), 210 frontend unit tests, and four feature-review browser tests.
Typecheck, production frontend build, backend build and Clippy also passed.
Mocked explorer integration covers search planning, selection from fetched IDs,
pinned README retrieval, empty searches, invalid selections, missing READMEs and
provider failures. Browser tests cover the two-field request, error retry,
desktop/mobile layouts and actual PDF/Markdown downloads. A live public GitHub
search smoke check returned valid results; full live AI report generation was
not tested, and the running service was not restarted.

```sh
# From backend/
cargo test feature_review
# From frontend/
bun run test:unit
bun run typecheck
bun run build
bun run test:e2e e2e/feature-review.spec.ts
```

Browser tests also require a freshly built debug backend (`cargo build`).

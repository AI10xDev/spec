# Feature Review Reports

Choose **Feature review** beside **Performance output**. Enter the public GitHub
repository URL and one to three competitor repository URLs, then choose
**Generate feature report**. The configured text provider in Settings (or the
server's text-provider environment) writes the review. This can incur provider
charges. It does not launch, save, cancel, or continue a build or Performance run.

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
  a lightweight Git ref, and reads the README at that commit. It does not crawl
  linked documentation, execute code, clone repositories or run their tests.
- Each README must be at most 128 KiB; the first 24 KiB is sent to the model.
  Truncation is disclosed. Metadata is current at fetch time, not historical
  commit metadata. GitHub rate limits or unavailable evidence fail the request
  rather than inventing sources.
- Competitors are chosen by the user, not discovered or ranked automatically.
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

If image configuration is missing or generation fails, the report remains
downloadable and explicitly says no AI image was generated. Fixed vector/Mermaid
workflow and evidence diagrams remain available. These are not represented as
GPT-image output. Generated illustrations are illustrative, not evidence.

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

```sh
# From backend/
cargo test feature_review
# From frontend/
bun run test:unit
bun run build
bun run test:e2e e2e/feature-review.spec.ts
```

Browser tests also require a freshly built debug backend (`cargo build`).

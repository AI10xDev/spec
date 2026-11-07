# Skills Marketplace

The marketplace lists descriptions of private GitHub skill files and unlocks the
pinned full markdown only after a verified PayPal capture. All provider requests
and credentials stay on the Rust server. No PayPal SDK, iframe, download URL,
browser GitHub token, or CSP relaxation is required.

## Modes and Ownership

- With **all marketplace variables absent**, Spec serves three real example
  markdown skills: `code-review`, `test-design`, and `release-check`.
- Demo is an explicit simulation. `POST /api/marketplace/orders` immediately
  grants the selected example, returns `purchased: true` and `approvalUrl: null`,
  and never contacts GitHub or PayPal. It must be labeled as a simulated purchase.
- Configured installations default to **sandbox**, not live. Live payments require
  explicit `SPEC_PAYPAL_MODE=live` and matching live merchant/app credentials.
- Any partial or invalid marketplace configuration fails startup with a sanitized
  error. Empty environment values count as configuration; they do not enable demo.
- If an existing saved AI profile allows startup despite an unreadable or malformed
  shared dotenv file, marketplace routes return 503 until that file is repaired and
  the server is restarted. They never assume missing configuration or enable demo.
- Entitlements belong to the **single shared Spec workspace**, not an individual
  browser or PayPal buyer. Every holder of that workspace's bearer token can read
  its purchased skills. There are no multi-user accounts or user-specific licenses.

No real purchases were performed during implementation or automated testing.
The automated provider tests use local fixtures, never real credentials.

## Workspace Flow

1. Open **Skills** in the Spec workspace header. The modal does not change the
   editor, save files, or launch builds; Escape or Close returns focus to Skills.
2. Select a listed file to preview its description, path, and price. With no
   configuration, three examples are provided and the purchase button explicitly
   says **Simulate purchase (no charge)**.
3. In sandbox or live mode, choose **Buy with PayPal**, then **Continue to PayPal**.
   The approval link opens a separate tab with no workspace token or opener access.
   Review the amount in PayPal before approving.
4. Return to the original modal and choose **Check payment**. This action captures
   an approved payment; merely returning from PayPal does not unlock the file.
   A failed or pending payment stays locked and can be checked again safely.
5. Choose **Display full contents** after verification (or explicit demo simulation).
   The pinned Markdown is fetched only on request and displayed as read-only text,
   never executed or automatically inserted into a spec. Hide clears the display.

Reopening the modal restores purchased files and unresolved orders. Catalog outages
show a warning alongside receipt-backed listings. If PayPal confirms an old order
is voided and unpaid, **Expired order? / Start a new order** requests a safe
replacement. Unknown, pending, or completed payments cannot be replaced.

## Server Setup

Configure these in the server environment or the same `.env` loader used by text
AI settings (nearest `.env`, or `SPEC_AI_ENV_FILE`). Process exports override file
values, including empty exports. Restart the server after changes.

| Variable | Meaning |
| --- | --- |
| `SPEC_SKILLS_GITHUB_TOKEN` | Fine-grained GitHub token restricted to this private repository, Contents read permission |
| `SPEC_SKILLS_GITHUB_REPO` | `owner/repository`, not a URL |
| `SPEC_SKILLS_GITHUB_REF` | Branch, tag, or commit; defaults to `main` |
| `SPEC_PAYPAL_CLIENT_ID` | PayPal REST app client ID for the selected mode |
| `SPEC_PAYPAL_CLIENT_SECRET` | Matching server-only app secret |
| `SPEC_PAYPAL_MERCHANT_ID` | Exact receiving business account merchant ID, not an email address |
| `SPEC_PAYPAL_RETURN_URL` | HTTPS URL returning the approval tab to Spec; no credentials, query string, or fragment |
| `SPEC_PAYPAL_MODE` | `sandbox` (default) or explicit `live` |

Use a sandbox business account/app as seller and a separate sandbox personal
account as buyer for manual acceptance testing. For a local installation, use a
trusted HTTPS reverse proxy to Spec for the return URL. Never include Spec's
`#token=...` fragment in that URL or pass the workspace bearer token to PayPal.
The already authenticated original tab remains the place to check payment.

The fixed upstream origins are `https://api.github.com`,
`https://api-m.sandbox.paypal.com`, and `https://api-m.paypal.com`. Redirects are
disabled. There are no configurable upstream HTTP endpoints in production.
Local origin injection exists only in Rust tests. Requests have a 5-second connect
timeout and a 20-second overall timeout each. Upstream response bodies and errors
are not forwarded to the browser or logged with credentials.

## Private Repository

Place `skills-index.json` at the repository root. This explicit manifest is the
authoritative catalog, preview text, and pricing source. It intentionally lists
only sellable skills, not arbitrary private files. The server resolves the
configured ref to a commit and checks every indexed path against that commit's
recursive Git tree. Symlinks, missing files, non-regular entries, duplicate IDs or
paths, traversal, and truncated trees are rejected. It fetches the selected file
by that tree's blob SHA only when an order is requested, never for a preview.

Example `skills-index.json`:

```json
{
  "skills": [
    {
      "id": "code-review",
      "name": "Code Review",
      "path": "review/skills.md",
      "description": "Review changes for correctness, security, and missing tests.",
      "price": "5.00",
      "currency": "USD"
    },
    {
      "id": "test-design",
      "name": "Test Design",
      "path": "testing/SKILL.md",
      "description": "Turn acceptance criteria into focused regression tests.",
      "price": "7.50",
      "currency": "USD"
    },
    {
      "id": "release-check",
      "name": "Release Check",
      "path": "release/skills.md",
      "description": "Prepare an evidence-based release checklist.",
      "price": "4.00",
      "currency": "USD"
    }
  ]
}
```

Populate the indexed files, for example:

`review/skills.md`:

```markdown
# Code Review

1. Read the diff and surrounding code.
2. Trace changed inputs through validation and persistence.
3. Check authorization and error paths.
4. Run focused regression tests.
5. Report actionable findings with file and line references, highest severity first.

Do not invent issues. State testing gaps explicitly.
```

`testing/SKILL.md`:

```markdown
# Test Design

1. List observable acceptance criteria.
2. Cover success, invalid input, and dependency failure.
3. Use isolated fixtures and deterministic clocks.
4. Assert observable behavior rather than implementation details.
5. Run focused and adjacent tests.

Never use production credentials or make real purchases in automated tests.
```

`release/skills.md`:

```markdown
# Release Check

1. Review all commits since the previous release.
2. Identify migrations and configuration changes.
3. Run tests, formatting, and static analysis.
4. Document rollback steps and known limitations.
5. Ask for explicit approval before publishing or deploying.

Separate verified results from assumptions.
```

IDs and path components use ASCII letters, digits, `-`, `_`, and `.`; neither `.`
nor `..` is a valid component. IDs/components are at most 100 bytes; paths at most
500 bytes. Filenames must be `skills.md` or `SKILL.md`, case-insensitively. Names
are at most 120 bytes, descriptions at most 2,000 bytes. Descriptions are deliberately
public to authenticated workspace users: do not put paid instructions or secrets
in them. Treat repository access as pricing-administrator access.

Prices are positive decimal strings with exactly two fractional digits and up to
six whole digits, with no leading zeroes except `0.xx`. Supported currencies are
`USD`, `EUR`, `GBP`, `CAD`, and `AUD`; this version deliberately excludes
zero-decimal and three-decimal currencies. Limits are 100 indexed skills, 128 KiB
manifest, 10,000 tree entries, 2 MiB GitHub JSON responses, and 32 KiB UTF-8 per
skill. NUL-containing or oversized content is rejected before creating a payment.

## API Contract

All routes require the existing `Authorization: Bearer <workspace-token>` and
return JSON with `Cache-Control: no-store`. The token is never a URL parameter.

`GET /api/marketplace`:

```json
{
  "mode": "sandbox",
  "repository": "owner/private-skills",
  "skills": [{
    "id": "code-review",
    "name": "Code Review",
    "path": "review/skills.md",
    "description": "Review changes for correctness and security.",
    "price": "5.00",
    "currency": "USD",
    "purchased": false,
    "order": {
      "id": "PAYPAL_ORDER_ID",
      "approvalUrl": "https://www.sandbox.paypal.com/checkoutnow?token=PAYPAL_ORDER_ID"
    }
  }]
}
```

`order` is omitted unless there is a known unresolved PayPal order. It restores
the approval link and Check payment action after a reload. No full skill body,
GitHub URL, blob URL, provider credential, or raw provider response is returned.

When GitHub is unavailable or its catalog is invalid, an installation with stored
receipts returns a receipt-backed catalog with the same configured `mode` and
`repository`, plus this optional top-level field:

```json
{
  "warning": "GitHub catalog unavailable. Showing stored purchases and orders only; new listings may be missing."
}
```

The warning is omitted after a successful catalog refresh. Display it visibly:
this is not the complete live catalog. Stored pending orders retain their approval
links and payment checks; purchased skills remain revealable. No pinned bodies or
provider errors are included in the catalog. If no receipts exist, the upstream
failure remains an error rather than an empty catalog or a silent demo fallback.

`POST /api/marketplace/orders` accepts only `{"skillId":"code-review"}` and
returns `{"id":"...","approvalUrl":"https://...","purchased":false}` for
PayPal, or `{"id":"...","approvalUrl":null,"purchased":true}` in demo.
Amounts, currency, merchant, content, and purchased state are never browser inputs.
The order freezes the price, description, commit, and full file at purchase
initiation. Repeated requests reuse that order rather than charging again.

Open the validated approval URL in a separate tab. Only HTTPS
`www.sandbox.paypal.com/checkoutnow` or `www.paypal.com/checkoutnow` URLs matching
the selected mode and order token are accepted. Returning from PayPal is **not**
proof of payment and does not unlock content. Approval alone does not capture a
charge: the user must click **Check payment** in the original modal.

`POST /api/marketplace/orders/{id}/capture` accepts `{}`. The server retrieves the
order, validates its amount/currency, merchant, and skill/request binding, and
captures only an approved matching order. It then retrieves the order again and
requires `COMPLETED`, exactly one final completed capture with the expected amount
and currency, the correct order ID, and the expected purchase unit. Pending,
declined, voided, cancelled, mismatched, and merely approved orders do not grant
access. Success is `{"purchased":true}`. Repeated checks are safe.

`POST /api/marketplace/orders/{id}/replace` accepts only `{}` and returns the same
`{"id":"...","approvalUrl":"https://...","purchased":false}` shape as order
creation. The **Start a new order** action is explicit; it never captures a charge.
The server retrieves the old order and requires its exact order/skill/request
binding, merchant, amount, currency, and terminal `VOIDED` status, with no captures
or other payments. Only then does it durably retire the old receipt and create a
new request ID and PayPal approval order. The replacement keeps the original pinned
file, description, revision, and price; it does not silently change the purchase
to a newer repository version.

`CREATED`, `APPROVED`, `PENDING`, `COMPLETED`, unknown or merely expired/cancelled
statuses, mismatched fields, and any capture history cannot be replaced (409).
PayPal 404, network failures, and malformed responses are ambiguous, not proof of
expiration; they do not retire the receipt or create an order. Merchant
reconciliation is needed for a missing provider order. Age alone never authorizes
replacement. Known captured purchases should use Check payment, not replacement.

Repeated replacement of the same retired ID reuses the skill's current replacement,
including after reload, timeouts, or failed writes. Concurrent Buy and replacement
requests cannot create extra active orders. If the replacement was already bought,
the response has `purchased: true`. Old capture endpoints reject retired IDs; the
catalog's `order` always refers to the current active order. If interrupted after
retirement but before a new intent, retry replacement or Buy for the same skill.

`GET /api/marketplace/skills/{id}/content` returns `{"content":"..."}` only for a
durably recorded entitlement; otherwise it returns 403. It reads the stored pinned
version, not a later repository edit, and does not need GitHub availability.

## Persistence and Recovery

Receipts use the existing hardened private settings storage: a sibling named
`profile.json.marketplace-<namespace>.json` (or the corresponding basename of
`SPEC_SETTINGS_FILE`). The default settings directory is a hashed sibling of the
workspace. It is outside both the editable workspace and static UI directory,
with 0700 directory/0600 file permissions, no symlink following, bounded reads,
atomic replacement, file sync, and directory sync. Do not relocate it inside a
workspace, expose it via static hosting, or include it in browser downloads.

A failed directory sync can leave a renamed receipt visible but not confirmed
durable. Every marketplace API access re-saves any loaded ledger under the
marketplace gate and requires successful file and directory synchronization before
exposing approval links, purchased state, or content, or making payment side
effects. A continuing sync failure returns 503, even after restart; visibility of
a receipt alone is not treated as proof of durability. Fix storage problems and
retry the same action. This intentionally also requires writable, healthy receipt
storage for revealing an existing purchase.

Demo has its own namespace. Real namespaces include mode and a fingerprint of the
repository, ref, PayPal client ID, and merchant. Changing those settings deliberately
does not reuse old entitlements; rotating a token or secret does not change the
namespace. Demo receipts are rejected in real mode even if copied across namespaces.
Back up this private directory securely: it holds paid file bodies and receipts.
The ledger is bounded to 100 receipts (including retained voided history) and
8 MiB. Replacement stops at this bound rather than deleting history. Do not delete it to troubleshoot a
payment; that removes the information needed to prevent duplicate purchases.

A pinned receipt and stable PayPal request ID are persisted **before** external
order creation. If the response or the following persistence step fails, repeat
Buy for the same skill: it uses the same create request ID and pinned purchase.
If an order ID has already been saved, the catalog restores it. An ambiguous
create without a saved provider ID is not replayed after five hours, conservatively
inside PayPal's default six-hour idempotency retention; the merchant must reconcile
it manually rather than risk creating a duplicate. Explicit replacement requires a
saved provider order ID and verified `VOIDED` status; it cannot bypass this ambiguity.
There is no automatic replacement, cancellation endpoint, or receipt deletion API.

Capture uses a separate stable request ID. A lost capture response or failed
receipt write leaves the order recoverable: repeat Check payment. Retrieval of
the completed order avoids a second capture, then the entitlement is persisted.
Fix reported storage permissions/access problems before retrying. Removed catalog
listings remain visible if they have a stored purchase or pending order. An upstream
catalog error returns the stored receipt-backed catalog with a warning; it does
not revoke receipts or block authenticated content/check endpoints. Retired
receipts remain in the private ledger for history, but their old approval links
are not exposed in the catalog. A durable retirement without a replacement intent
appears as an unpurchased skill with no order until explicitly retried.

The workspace startup lock and marketplace gate serialize receipt updates. This
is not a multi-server payment database. Do not share one settings file across
separate workspace servers. Refunds, disputes, revocation, tax, licensing policy,
and merchant reconciliation are outside this minimal implementation. There are no
webhooks; successful entitlements are not automatically revoked after refunds.
As with other local settings, a trusted OS account or arbitrary code execution on
the server can access its private storage; this is not DRM against the server owner.

## Verification

From `frontend/`, run `bun run build` and `bunx playwright test e2e/marketplace.spec.ts`
after building the debug backend with `cargo build` in `backend/`. The browser
suite exercises the real demo backend and mocked PayPal flows, focus wrapping,
explicit reveal, recovery, editor isolation, and desktop/mobile layouts. It blocks
external provider navigation and never makes real purchases.

From `backend/`, run `cargo test marketplace` and `cargo clippy --all-targets -- -D warnings`.
`src/marketplace_tests.rs` uses test-only local GitHub/PayPal fixtures to exercise
authorization, preview/content gating, server-authoritative pricing, pinned
content, invalid captures, retries, persistence errors (including post-rename
directory-sync failures), reloads, namespace separation, configuration validation,
bounds, redirects, and secret-safe errors. They also cover receipt-backed outage
catalogs, safe `VOIDED` replacement, ambiguous/unsafe replacement rejection,
retained history, concurrent retries, and interrupted retirement recovery.
Manual sandbox acceptance should additionally verify the real PayPal approval tab
and return navigation before deliberately enabling live mode.

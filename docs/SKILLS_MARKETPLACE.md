# Skills Marketplace

The marketplace lists descriptions of private GitHub skill files and unlocks the
pinned full markdown only after a verified PayPal capture. GitHub access, PayPal
secrets, order creation and capture stay on the Rust server. Checkout uses
`@paypal/paypal-js/sdk-v6`, following the public-client-ID one-time-payment flow in
[PayPal's v6 sample integration](https://github.com/paypal-examples/v6-web-sdk-sample-integration).
The browser receives only the public PayPal client ID, never the app secret,
GitHub token, or server OAuth access token.

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

1. Open the large, rainbow **Purchase Skills** button centered at the top of the
   Spec workspace. On narrower screens it has its own top row above the other
   header controls. Browsing, purchasing and revealing do not change the editor,
   save files, or launch builds; Escape or Close returns focus to Purchase Skills.
2. Select a listed file to preview its description, path, and price. With no
   configuration, three examples are provided. The rainbow **Purchase Skills**
   button has an associated **Simulated purchase (no charge)** explanation in demo.
3. In sandbox or live mode, wait for PayPal eligibility and choose **Purchase Skills**.
   The v6 SDK opens a popup without redirecting away from unsaved editor work.
   Review the amount in PayPal; approval authorizes server-side capture. Sandbox
   and live payments are explicitly distinguished beside the button.
4. The SDK approval callback requests capture and unlocks only after server
   verification. A failed, cancelled, pending or merely returned payment stays
   locked. **Check payment** remains available to safely recover interrupted
   captures. If popups are blocked, refresh the catalog to recover the saved order
   and use **Continue to PayPal** (a separate tab with no workspace token or opener
   access), then **Check payment**. Neither SDK availability nor a callback alone
   proves payment.
5. Choose **Display full contents** after verification (or explicit demo simulation).
   The pinned Markdown is fetched only on request and displayed as read-only text,
   never executed or automatically inserted into a spec. Hide clears the display.
6. Optionally choose **Enable editing** for an unlocked skill. This opens a new
   editable workspace copy named `skill-<id>.md`, using `-2`, `-3`, etc. when a saved
   file or open tab already uses that name. Existing files and unsaved buffers are
   preserved. The copy starts unsaved; Save and the editor's normal autosave after
   user edits persist it through the existing revision-checked file API. A concurrent
   filename collision produces a save conflict rather than an overwrite.

Editing a copy does not change the pinned purchase receipt, GitHub source, price,
or entitlement. Reopen the saved copy through the workspace file list to continue
editing it; selecting Enable editing again creates another copy. Closing the
marketplace during a content load or file-list refresh cancels the operation.
No build, checkout, or repository push is launched by Enable editing. Configured
editor completion behavior remains controlled by the existing editor setting.

Reopening the modal restores purchased files and unresolved orders. Catalog outages
show a warning alongside receipt-backed listings. If PayPal confirms an old order
is voided and unpaid, **Expired order? / Start a new order** requests a safe
replacement. Unknown, pending, or completed payments cannot be replaced.
Repeated approval callbacks share one capture attempt. Closing the modal destroys
the SDK session and invalidates late callbacks without cancelling a provider order.
An SDK failure never silently creates a replacement or switches to demo mode.

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
| `SPEC_SKILLS_PUBLIC_EXAMPLES` | Optional exact `1`: anonymous access only to `AI10x/skills-marketplace-examples`, with explicit `SPEC_PAYPAL_MODE=sandbox` |

The example repository is temporarily public for testing. To test without a
GitHub token, explicitly set `SPEC_SKILLS_PUBLIC_EXAMPLES=1` and the exact example
repository above. Omit or clear `SPEC_SKILLS_GITHUB_TOKEN`; a nonempty inherited
token is rejected in public-example mode. No Authorization header is sent to
GitHub. Private mode remains the default and never falls back to anonymous access.
Other flag values, repositories or live payments are rejected by this test option.
Anonymous GitHub requests have lower rate limits (typically 60/hour per IP).
Anyone can read or copy full public skill files without paying; this is not a
production paywall. Restore repository privacy after testing and remove the flag
before configuring a repository-scoped read token. Visibility has no automatic expiry.

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

## Secure Operator Setup

Run this **yourself in a private, unrecorded terminal on the server**, as the OS
account that runs Spec. Python 3.9+ on POSIX is sufficient; there are no Python
dependencies, network requests, browser prompts, or reads of existing credentials.
Never paste credentials into chat, a spec, command arguments, shell history, or
browser settings. All answers (including repository, URL and mode) use `getpass`
without echo. Piped/non-TTY input and echo fallback are refused.

```sh
python3 /home/opencode/spec/scripts/setup_marketplace.py
```

The default new file is `.spec-marketplace/marketplace.env` under the OS account's
login home (not an inherited `HOME` override). To choose a different absolute path
or declare nonstandard server workspace/static roots:

```sh
python3 /home/opencode/spec/scripts/setup_marketplace.py \
  --output /absolute/private-parent/marketplace.env \
  --workspace /absolute/editable-workspace \
  --ui-dir /absolute/static-ui
```

Supply the actual roots if different from `SPEC_WORKSPACE` / `SPEC_UI_DIR` in the
setup process environment or the repository defaults (`workspace`, `frontend/dist`).
The helper rejects output inside those trees or anywhere in this repository.
Do not serve, edit through Spec, sync publicly, or commit the private output.
It cannot discover other servers' roots, bind mounts, or later hosting changes.

Have a fine-grained GitHub token with Contents read permission for only the private
skills repository, its `owner/repository` and ref (default `main`), the matching
PayPal app client ID/secret and business merchant ID, and the HTTPS Spec return URL
ready. Values must be printable ASCII without whitespace/newlines; errors never
repeat input. The URL must not contain credentials, query parameters, or fragments.
Mode defaults to `sandbox`. Selecting `live` additionally requires typing
`ENABLE LIVE PAYMENTS`; saving always requires `SAVE`. This does not verify provider
credentials or make payments. Test sandbox separately before enabling live.

Only the immediate private parent is created, with mode `0700`; earlier ancestors
must exist and be trusted. An existing parent must already be owned by this account
with exactly `0700`. Files are `0600`, path components cannot be symlinks, and an
existing destination (including a dangling symlink) is always refused, never read
or overwritten. Complete output is synchronized and published without replacement.
Cancellation before publication leaves no final config; handled failures clean
temporary files. A hard kill or power loss can leave a private temporary file, and
a final sync failure can leave a complete destination: inspect privately rather
than blindly retrying or deleting it. No values are printed to stdout or stderr.
Storage is private plaintext, not encryption against the OS account or root.

Point the **server process** at the new absolute file and restart it using your
normal launcher, for example set this non-secret path in its launch environment:

```sh
export SPEC_AI_ENV_FILE=/absolute/private-parent/marketplace.env
```

Use the default file's absolute login-home path if you did not pass `--output`.
Do not `source` the file or print its contents. This selects the existing **shared
AI dotenv override**: it replaces nearest-`.env` discovery, it does not merge with
the old file. The helper writes only marketplace variables, so previously
file-only text-AI/Azure voice settings may stop loading. Preserve those separately
in the server's protected launch configuration or deliberately maintain a combined
private dotenv outside this helper. Saved AI profiles retain their existing
precedence. Existing process exports, including empty marketplace exports, override
the file and must be reconciled before restarting. This helper neither rewrites
existing settings nor starts/stops the server.

Offline checks (synthetic values only):

```sh
python3 -m unittest discover -s scripts -p 'test_setup_marketplace.py' -v
```

The actual Rust `dotenvy` quoting round-trip check needs `rustc` and a previously
built debug backend dependency in `backend/target/debug/deps`; otherwise that check
is explicitly skipped. No interactive prompt or real credential is needed.

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

`GET /api/marketplace/paypal-sdk` returns only
`{"clientId":"public-app-id","environment":"sandbox"}` (or `"production"` for
live mode). It requires workspace authentication and healthy receipt storage,
uses `Cache-Control: no-store`, and returns 503 in demo or unavailable mode.
The frontend validates mode consistency before loading the SDK and checks PayPal
eligibility for the selected currency. Initialization errors disable purchase and
offer an explicit retry without creating an order. After changing sandbox/live
server configuration, save editor work and fully reload the page: the SDK loader
reuses its global namespace and the document's CSP is fixed at load time.

In configured mode only, CSP permits scripts from the fixed environment's
`https://www.sandbox.paypal.com` or `https://www.paypal.com` origin, and PayPal
connections/frames/images plus `https://www.paypalobjects.com`. It does not add
wildcards, unsafe script directives, arbitrary return-URL origins, or external
permissions in demo. COOP becomes `same-origin-allow-popups` for SDK communication.
This is a trust expansion: provider JavaScript runs in the editor's origin and
has that origin's privileges. Only enable configured checkout where trusting the
PayPal SDK alongside the workspace is acceptable. This is not an isolated-origin
payment application. Credentials are collected only by the offline operator
helper, never by this third-party-script-enabled page.

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

The SDK receives the server-created order ID through a promise passed to
`session.start()` synchronously within the click gesture; order creation is not
awaited before opening the popup. The approval callback must match that exact
order ID before calling the capture endpoint. No price or merchant comes from
the SDK callback. Capture failure rejects the callback; normal session cleanup
waits for SDK completion. The explicit fallback can open the validated approval
URL in a separate tab. Only HTTPS
`www.sandbox.paypal.com/checkoutnow` or `www.paypal.com/checkoutnow` URLs matching
the selected mode and order token are accepted. Returning from PayPal is **not**
proof of payment and does not unlock content. In the SDK flow approval initiates
server capture; for the fallback tab, click **Check payment** in the original modal.

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
suite exercises the real demo backend and mocked v6 SDK/PayPal flows, focus wrapping,
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
The browser regressions also cover eligibility/config failures, explicit SDK retry,
rainbow styling, popup failure before order creation returns, duplicate and stale
callbacks, callback rejection/completion ordering, and mode-change reload gating.
Run `python3 -B -m unittest discover -s scripts -p 'test_setup*.py'` for setup tests
(Rust/Cargo is used for the actual `dotenvy` round-trip check).

Manual sandbox acceptance is still required with real app credentials. Verify
SDK/module loading under the deployed CSP, popup approval/cancellation, automatic
capture and explicit reveal, then blocked-popup fallback and recovery. Repeat on
desktop and mobile before deliberately enabling live mode. Automated tests mock
the SDK and do not prove real provider/CSP compatibility or make real purchases.

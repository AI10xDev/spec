# Subpath And Server-Auth Deployment

Build the full workspace, not a separate marketplace page:

```sh
SPEC_PUBLIC_BASE_PATH=/paypal/skills-marketplace/ VITE_SPEC_GATEWAY_AUTH=1 bun run build
```

- `SPEC_PUBLIC_BASE_PATH` is a build-process environment variable. Default: `/`. A missing trailing slash is normalized. Use an absolute pathname of safe alphanumeric, dash, underscore, tilde and dot-containing segments (no dot segments, query, fragment or origin). It configures Vite's `base`, including initial CSS/JS and lazy-loaded chunks. Runtime URLs use Vite's `import.meta.env.BASE_URL`.
- `VITE_SPEC_GATEWAY_AUTH=1` is the only value that enables server-auth mode. Otherwise the existing fragment/session-storage workspace-token login and Bearer headers remain unchanged. In gateway mode the app connects automatically, does not read or write the workspace token, and emits no JavaScript `Authorization` header, including for editor completions. Same-origin fetch defaults allow browser HTTP Basic auth. Failures retain a token-free retry button.
- Both settings are public build configuration, not credentials. Rebuild when changing them. Never put workspace, provider, GitHub, PayPal-secret or gateway credentials in `VITE_*` variables or frontend files.

## Gateway Contract

The gateway is external to this frontend. No gateway or backend is implemented here.

1. Authenticate every document, asset and API request over HTTPS. Browser `Authorization: Basic ...` must reach the gateway unchanged. After validating it, the gateway replaces it with the server-held workspace `Authorization: Bearer ...` on upstream API requests. Never return that bearer to the browser. Do not interpret the build flag as authentication or expose the Rust server publicly.
2. Serve the document at `/paypal/skills-marketplace` (Nextweb's slashless canonical URL) or `/paypal/skills-marketplace/`. Do not add a slash redirect that conflicts with the host's normalization. Strip exactly `/paypal/skills-marketplace` before forwarding to the Rust origin: prefixed `/api/config` becomes `/api/config`, prefixed `/assets/...` becomes `/assets/...`, and either app document becomes `/`. Preserve encoded names and query strings, including `?chat=...`. Point the Rust server's existing `SPEC_UI_DIR` setting at this build's output directory (`frontend/dist` by default). Do not fall back to Nextweb's index for these requests.
3. Forward GET, HEAD, POST, PUT and DELETE as applicable, with request bodies and content types intact. Preserve response status, content type, `Cache-Control: no-store`, CSP, COOP and other security headers. Keep private API responses out of shared caches. Rewrite any upstream-local redirects into the public prefix; never expose a private origin or token-bearing redirect. Keep upstream asset paths confined to the deployed UI directory.
4. Preserve streaming bodies, cancellation and long-lived responses without buffering. Allow adequate timeouts for AI, feature review, execution and uploads. The current app uses JSON requests and polling, **not SSE or WebSocket routes**; no SSE URL exists in this checkout. If the upstream later supplies `text/event-stream`, relay it unchanged with no buffering/caching rather than parsing it as JSON. Realtime voice uses POST signaling below, then browser WebRTC, not a gateway SSE connection.
5. Deny token-disclosure/bootstrap routes, including `/auth`, `/token`, `/bootstrap` and their `/api/` equivalents if offered by an upstream wrapper. There is **no HTTP token-bootstrap endpoint in the current Rust router**. Root mode bootstraps only from the server-printed `/#token=...` fragment or manually entered token; fragments never reach the server. Gateway mode needs neither and must not redirect users to such a URL. The normal upstream `/` is required for `index.html`; do not block the app document when denying root-level token routes.
6. Treat access as access to the **entire shared workspace**, not just paid skills: settings, files, AI calls, execution and shared purchase entitlements are available according to server capabilities. Enforce gateway origin/CSRF protections for unsafe methods; preserve the backend's limits and server-side payment verification. PayPal v6 still needs its external environment-specific scripts/popups and the existing CSP/COOP allowances. Do not rewrite external PayPal approval URLs under the prefix.

## Upstream Requests

All paths below are upstream-root paths; browsers add the configured public prefix. These are the current Rust router's APIs, not a marketplace-only allowlist:

| Area | Methods And Paths |
| --- | --- |
| App and assets | GET/HEAD `/`, `/?chat=<encoded-name>`, `/assets/*` (including lazy export chunks) |
| Startup | GET `/api/config`, `/api/files` |
| Files and logs | GET/PUT `/api/files/{name}`; GET `/api/files/{name}/run`, `/api/files/{name}/run/log`, `/api/files/{name}/retained-runs`, `/api/files/{name}/retained-runs/{id}/log` |
| Runs and queue | GET/POST `/api/runs`; GET `/api/runs/{id}`, `/api/queued-builds`; POST `/api/runs/{id}/cancel`, `/api/runs/{id}/continue`; POST/DELETE `/api/runs/{id}/queued-build` |
| Repository and optimization | GET `/api/repository`; POST `/api/repository/save`; GET/POST `/api/optimize` |
| Performance | GET/POST `/api/performance`; GET `/api/performance/runs`, `/api/performance/runs/{id}`; POST `/api/performance/runs/{id}/cancel`, `/api/projects/search` |
| AI and review | POST `/api/completions`, `/api/chat`, `/api/analytics`, `/api/memory/graphql`; GET/POST `/api/feature-review` |
| Voice signaling | POST `/api/realtime`, `/api/realtime/azure` (JSON containing SDP; subsequent media/data use WebRTC) |
| Settings and storage | GET/PUT/DELETE `/api/settings`, `/api/settings/storage`; POST `/api/settings/storage/upload` |
| Computer use | GET `/api/computeruse`, `/api/computeruse/file`; POST `/api/computeruse/push`, `/api/computeruse/pull`, `/api/computeruse/run`, `/api/computeruse/runs/{id}/cancel` |
| Marketplace | GET `/api/marketplace`, `/api/marketplace/paypal-sdk`, `/api/marketplace/skills/{id}/content`; POST `/api/marketplace/orders`, `/api/marketplace/orders/{id}/capture`, `/api/marketplace/orders/{id}/replace` |

`/api/marketplace/paypal-sdk` returns public SDK configuration, not a workspace bearer. PayPal OAuth `/v1/oauth2/token` is a server-to-PayPal call, not a browser bootstrap route to proxy. Private GitHub and AI provider calls likewise originate on the server. Source of the route inventory: `../backend/src/main.rs` (`router`, `browser_router`).

## Local Checks

```sh
bun run test:unit
bun run build
bunx playwright test e2e/subpath.spec.ts e2e/marketplace.spec.ts --reporter=dot
```

The subpath suite requires the existing `../backend/target/debug/spec` binary. It builds isolated prefixed assets under `/tmp/opencode`, runs a fresh provider-free Rust workspace behind a test-only Basic gateway, and checks real demo purchases, files, completion request routing, assets, chat navigation and connection retry. It advertises completions solely to exercise the real endpoint's credential-free failure. It does not test the actual Nextweb proxy, live providers, real payments or SSE.

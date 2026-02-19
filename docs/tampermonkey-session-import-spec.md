# Tampermonkey Script Spec: OpenCode Session Discovery & Import Overlay

## 1) Goal
Build a Tampermonkey userscript that can connect to OpenCode web endpoints, list currently available sessions in that OpenCode instance, and present an in-page overlay to:

- Import a single selected session.
- Import all listed sessions in one action.

This spec is intentionally implementation-ready but scoped to **v1** behavior only.

## 2) In-Scope (v1)
- Run as a Tampermonkey userscript in supported browsers.
- Detect or configure target OpenCode base URL.
- Query OpenCode session-list endpoint(s) and fetch session metadata.
- Render a UI overlay showing available sessions.
- Support two import flows:
  - **Per-session import** (user clicks one row).
  - **Bulk import all** (single action button).
- Show progress, success, and failure statuses in overlay.
- Allow closing/reopening overlay without page reload.

## 3) Out of Scope (v1 Non-Goals)
- Auto-sync/background polling after initial manual refresh.
- Editing session contents before import.
- Cross-instance merge/conflict resolution logic beyond simple skip/replace mode.
- Server-side endpoint changes (script consumes existing endpoints only).
- Mobile UI optimization.

## 4) Assumptions / Dependencies
- OpenCode exposes session APIs over authenticated web requests reachable from the user’s browser context.
- The destination web app already has (or can accept) a known import pathway (endpoint or local integration hook).
- User is already authenticated in the same browser context for needed endpoints.
- CORS/CSRF behavior allows requests from userscript context (via `GM_xmlhttpRequest` if needed).

## 4.1) API Investigation Snapshot (Pre-Implementation)

The repository currently contains only specification and skill documents, with no runtime OpenCode API client code to derive contracts from. This section defines what must be verified from an API perspective before implementation begins.

### Required API surfaces and current confidence

| Surface | Purpose | Candidate contract in v1 spec | Confidence | Blocking gap |
|---|---|---|---|---|
| Source session list | Discover importable sessions | `GET {opencodeBaseUrl}/api/sessions` | Low | Unknown real route and response envelope |
| Source single session | Resolve full payload before import | `GET {opencodeBaseUrl}/api/sessions/{id}` | Low | Unknown if list payload is already full-fidelity |
| Destination import | Create/import session into target web | Adapter-based `importSession(sessionData, options)` | Low | Unknown endpoint/hook, payload schema, and conflict response |
| Auth mode | Allow cross-origin requests from userscript | Cookie/session first, optional bearer token | Medium-Low | Unknown if CSRF token is required per request |
| Conflict detection | Skip/replace behavior | `importMode`: `skip-existing` / `replace-existing` | Low | Unknown how destination reports "already exists" |

### API discovery checklist (must complete before coding)

1. Confirm source list endpoint path, method, and response envelope.
2. Confirm whether source list item contains all data needed for import or requires detail fetch.
3. Confirm destination import endpoint/hook and exact accepted payload shape.
4. Confirm destination idempotency/conflict semantics and HTTP status mapping.
5. Confirm auth model for both source and destination (cookie-only vs token vs mixed).
6. Confirm CSRF/header requirements for write operations.
7. Confirm pagination behavior (none/cursor/page-size defaults/max).
8. Confirm rate limits and retry-safe status codes.


## 4.2) API Investigation Findings (Current Environment)

This investigation attempted to validate OpenCode session APIs from the current execution environment before implementation.

### Evidence gathered
- The repository itself contains no OpenCode runtime/API implementation code, only planning/spec/skill documents.
- External documentation and repository lookups were attempted but blocked by network egress policy in this environment (`CONNECT tunnel failed, response 403`).
- Because of that limitation, no authoritative public API contract could be fetched from upstream sources during this pass.

### What is now known vs unknown
- **Known**:
  - No local source-of-truth API schema is present in this repository.
  - Spec placeholder routes (`/api/sessions`, `/api/sessions/{id}`) remain unverified and must not be treated as final.
- **Unknown (still blocking)**:
  - Exact source list/detail paths, envelope shape, pagination model.
  - Destination import endpoint/hook contract and conflict semantics.
  - Required auth/CSRF headers for write operations.

### Required contract capture process (next investigation step)
1. Capture network traces from a real OpenCode web session while:
   - opening session list,
   - opening a single session,
   - importing/creating a session (if native UI supports it).
2. Export sanitized request/response examples for each endpoint.
3. Record for each endpoint:
   - method + path,
   - required headers/cookies/CSRF,
   - query params,
   - success response schema,
   - failure schema and status codes.
4. Convert captured payloads into test fixtures used by the userscript normalization/import tests.

### Provisional compatibility policy until contracts are confirmed
- Keep endpoint paths configurable in settings.
- Support common response envelopes (`items`, `data`, root-array).
- Keep detail-fetch optional behind capability detection.
- Treat import success as contract-driven (not status-code-only) to avoid false positives.

## 5) User Stories
1. **Discover sessions**
   - As a user, I can open an overlay and fetch all sessions from my current OpenCode instance.
2. **Import one**
   - As a user, I can click a specific listed session and import only that session.
3. **Import all**
   - As a user, I can trigger import for all visible sessions at once.
4. **See status**
   - As a user, I can see which imports succeeded, failed, or were skipped.

## 6) Functional Requirements

### 6.1 Script Bootstrapping
- Provide Tampermonkey metadata block:
  - `@name`, `@namespace`, `@version`, `@description`
  - `@match` rules for target web UI pages
  - `@grant` values (`GM_xmlhttpRequest`, `GM_setValue`, `GM_getValue`, `GM_registerMenuCommand`)
  - `@connect` for allowed OpenCode host(s)
- Register menu command(s):
  - “Open Session Import Overlay”
  - Optional: “Configure OpenCode Endpoint”

### 6.2 Endpoint Configuration
- Configuration model:
  - `opencodeBaseUrl` (string)
  - Optional `apiToken` if endpoint requires custom bearer auth (fallback to cookie auth)
  - `importMode` default (`skip-existing` or `replace-existing`)
- Persist config via Tampermonkey storage.
- Validate URL format before save.

### 6.3 Session Discovery
- Triggered by overlay open and manual refresh button.
- Request session list from configured endpoint (example placeholder path):
  - `GET {opencodeBaseUrl}/api/sessions`
- If the source endpoint is paginated, iterate until completion before rendering final list (or render incrementally with explicit "partial" state).
- Normalize response to required client shape:
  - `id` (required)
  - `title` (fallback: `Session {id}`)
  - `updatedAt` (optional)
  - `summary` (optional)
  - `raw` (full source object retained for import)
- Sort default by `updatedAt desc` where available.
- Envelope handling must be configurable (`items`, `data`, or root-array) until API contract is confirmed.

### 6.4 Overlay UI/UX
- Overlay panel (fixed, high z-index, keyboard accessible):
  - Header with title + close button.
  - Controls row: Refresh, Import All, Settings.
  - Search/filter input by title/id.
  - Sessions table/list with per-row “Import” button.
  - Status area for logs/progress.
- Visual statuses for each row:
  - `idle`, `importing`, `imported`, `failed`, `skipped`.
- Disable duplicate action while a row or bulk import is in progress.

### 6.5 Import Behavior
- **Single import**:
  - user clicks row import button.
  - script fetches full session if needed (`GET /api/sessions/{id}`) then sends to destination import endpoint.
- **Bulk import**:
  - imports all currently filtered/visible sessions.
  - sequential by default (safer error handling); optional future parallelism.
- Import endpoint shape is adapter-based:
  - `importSession(sessionData, options)` interface in script.
  - supports conflict mode: `skip-existing` or `replace-existing`.
- Per-item result recorded and surfaced in UI.
- Destination import success criteria must be explicit: accepted HTTP statuses and response markers for `imported` vs `skipped`.

### 6.6 Error Handling
- Distinguish and message common failures:
  - Missing configuration
  - Unauthorized (401/403)
  - Network/CORS failure
  - Invalid response shape
  - Import endpoint rejection
- Bulk import continues after individual failure; produce final summary counts.
- Add explicit mapping for: `409 conflict`, `422 validation`, and `429 rate-limited` once destination contract is confirmed.

### 6.7 Security/Privacy
- Do not log tokens in console/UI.
- Store only minimal required settings in Tampermonkey storage.
- Sanitize any server-returned HTML/strings before rendering in overlay (render as text, not HTML).

## 7) Data Contracts (Initial Draft)

### 7.1 SessionListItem (normalized)
```ts
interface SessionListItem {
  id: string;
  title: string;
  updatedAt?: string;
  summary?: string;
  raw: unknown;
}
```

### 7.2 ImportResult
```ts
interface ImportResult {
  sessionId: string;
  status: 'imported' | 'failed' | 'skipped';
  message?: string;
}
```

## 8) UX Flow
1. User opens target page.
2. User launches overlay via menu command or floating launcher button.
3. Script loads config and requests session list.
4. Sessions display in table/list.
5. User either:
   - Clicks one session’s **Import** button, or
   - Clicks **Import All**.
6. Overlay shows real-time progress and final summary.

## 9) Acceptance Criteria
- Overlay opens/closes reliably without page refresh.
- Session list loads from configured OpenCode endpoint and displays at least id/title.
- Clicking a row imports exactly that session and updates row status.
- Clicking Import All processes all visible sessions and shows aggregate summary.
- Failures are non-fatal for batch flow and clearly visible.
- Config persists across page reloads.

## 10) Edge Cases
- Empty session list (show empty-state message).
- Duplicate session IDs in source payload (dedupe by id and warn).
- Destination already has session:
  - Respect conflict mode (`skip-existing` vs `replace-existing`).
- Session list partially malformed:
  - Skip invalid records and report count.
- User closes overlay during import:
  - continue in background for current page session, reopen shows latest state.

## 11) Test Plan (for implementation phase)
- Unit tests (if script bundled in repo tooling):
  - response normalization
  - dedupe logic
  - conflict-mode branching
  - error mapping/user-friendly messages
- Manual browser validation in Tampermonkey:
  - configure endpoint
  - list sessions
  - import single
  - import all with mixed success/failure
  - refresh and re-open overlay

## 12) Open Questions for Iteration
- Exact source endpoint contract for listing + fetching single session?
- Exact destination import endpoint/JS hook and expected payload?
- Should “Import All” target all loaded sessions or only currently filtered list?
- Need retry button per failed item in v1, or defer to v2?
- Need dry-run mode before actual import?

## 12.1) Implementation Knowledge Gaps Register

The following gaps must be resolved (or explicitly assumed) before implementation.

### A. Source API contract gaps
- **A1. List route + envelope**: actual route, expected query params, and whether response is root-array or wrapped object.
- **A2. Pagination**: cursor/page params, default page size, and termination condition.
- **A3. Required fields**: minimum stable identifiers (`id`, alternate keys) and timestamp field names.
- **A4. Detail fetch necessity**: whether list payload is import-ready or requires per-session detail call.
- **A5. Deleted/archived semantics**: whether source list includes non-importable states.

### B. Destination import contract gaps
- **B1. Import route/hook**: HTTP endpoint versus in-page JS integration.
- **B2. Payload schema**: accepted fields, strictness, and maximum payload size.
- **B3. Conflict semantics**: how destination reports existing sessions (status code, error code, body flag).
- **B4. Replace behavior**: whether replacement is atomic and whether identifier remains stable.
- **B5. Idempotency**: whether repeated import calls are safe and how duplicates are detected.

### C. Auth/security gaps
- **C1. Auth transport**: cookie/session, bearer token, or both; precedence if both provided.
- **C2. CSRF policy**: required CSRF header/cookie pair for destination writes.
- **C3. CORS behavior**: whether browser `fetch` works or `GM_xmlhttpRequest` is required for all cross-origin calls.
- **C4. Token lifecycle**: expiration handling and user-visible remediation flow.

### D. Operational and UX gaps
- **D1. Import-all scope**: all fetched sessions vs currently filtered/visible list.
- **D2. Retry policy**: immediate retry button per-row and capped automatic retries for transient errors.
- **D3. Throughput limits**: safe concurrency level if sequential mode is too slow.
- **D4. Long-run feedback**: progress granularity for large session counts.

### E. Testability gaps
- **E1. Contract fixtures**: representative source/destination success + failure payloads.
- **E2. Deterministic mocks**: test harness for pagination, conflicts, and rate limiting.
- **E3. Manual verification environment**: known endpoint sandbox/staging target for repeatable QA.

### Gap-resolution exit criteria
- All A/B/C gaps resolved with either validated contract docs or explicit assumptions approved by product owner.
- D gaps resolved into concrete v1 behavior statements.
- E gaps resolved enough to run deterministic unit tests and repeatable manual validation.

## 13) Proposed v1 Implementation Phases (next step)
1. Scaffold userscript + config storage.
2. Implement overlay shell + session listing.
3. Implement single import adapter and per-row status.
4. Implement bulk import and summary reporting.
5. Harden error handling + UX polish.

# Tampermonkey Script Spec: OpenCode Session Discovery & Reveal Overlay

## 1) Goal
Build a Tampermonkey userscript that can connect to OpenCode web endpoints, list currently available sessions in that OpenCode instance, and present an in-page overlay to:

- Reveal/open a single selected session in the current Web UI.
- Reveal/open all listed sessions in one action.

This spec is intentionally implementation-ready but scoped to **v1** behavior only.

## 2) In-Scope (v1)
- Run as a Tampermonkey userscript in supported browsers.
- Detect or configure target OpenCode base URL.
- Query OpenCode session-list endpoint(s) and fetch session metadata.
- Render a UI overlay showing available sessions.
- Support two reveal flows:
  - **Per-session reveal** (user clicks one row).
  - **Bulk reveal all** (single action button).
- Show progress, success, and failure statuses in overlay.
- Allow closing/reopening overlay without page reload.

## 3) Out of Scope (v1 Non-Goals)
- Auto-sync/background polling after initial manual refresh.
- Editing session contents.
- Cross-instance import/sync into a different OpenCode server.
- Server-side endpoint changes (script consumes existing endpoints only).
- Mobile UI optimization.

## 4) Assumptions / Dependencies
- OpenCode exposes session APIs over authenticated web requests reachable from the user’s browser context.
- Source and destination are the same OpenCode server/storage instance in v1.
- User is already authenticated in the same browser context for needed endpoints.
- CORS/CSRF behavior allows requests from userscript context (via `GM_xmlhttpRequest` if needed).

## 4.1) API Investigation Snapshot (Validated)

This section is now based on direct upstream OpenCode source inspection on February 19, 2026 (`sst/opencode` HEAD at investigation time), including server route definitions and SDK-generated API types.

### Required API surfaces and current confidence

| Surface | Purpose | Confirmed contract in v1 spec | Confidence | Remaining gap |
|---|---|---|---|---|
| Source session list | Discover importable sessions | `GET {opencodeBaseUrl}/session` | High | None |
| Source session metadata | Resolve session-level metadata | `GET {opencodeBaseUrl}/session/{sessionID}` | High | None |
| Source session transcript | Optional prefetch for richer open experience | `GET {opencodeBaseUrl}/session/{sessionID}/message` | High | None |
| Source session diff (optional) | Preserve review/change context | `GET {opencodeBaseUrl}/session/{sessionID}/diff` | High | Optional for v1 |
| Visibility nudge | Trigger Web UI store refresh event for an existing session | `PATCH {opencodeBaseUrl}/session/{sessionID}` with existing title | High | None |
| Auth mode | Browser access to endpoints | Cookie/session-first, optional Basic Auth fallback | Medium-High | None for v1 |
| Conflict detection | Skip/replace behavior | Not applicable in v1 (server is source of truth) | High | None for v1 |

## 4.2) API Investigation Findings (Current Environment)

### A. Confirmed source contracts (OpenCode local server)

- **Base URL**: default SDK target is `http://localhost:4096`.
- **List sessions**: `GET /session`
  - Query: `directory`, `roots`, `start`, `search`, `limit`.
  - Response: root JSON array of `Session` objects.
  - Ordering: newest first (`time.updated desc`).
  - Effective page size: no cursor paging; DB query limit defaults to `100` when omitted.
- **Get one session (metadata)**: `GET /session/{sessionID}`
  - Response: one `Session` object (same shape family as list item).
- **Get transcript**: `GET /session/{sessionID}/message`
  - Response: array of `{ info: Message, parts: Part[] }`.
  - Optional in v1 reveal flow (used for prefetch only).
- **Optional diff**: `GET /session/{sessionID}/diff?messageID=...`
  - Response: `FileDiff[]`.

### B. Auth/CORS findings

- OpenCode local server can require HTTP Basic Auth when `OPENCODE_SERVER_PASSWORD` is configured.
- Username defaults to `opencode` unless `OPENCODE_SERVER_USERNAME` is set.
- OpenCode local server includes CORS handling and allows browser `fetch` from localhost/tauri and allowed domains.
- No CSRF-specific token requirement is defined in the inspected OpenCode local-server routes.
- v1 auth policy: use browser cookie/session auth first; if unavailable/failing, allow optional configured Basic Auth fallback.

### C. Error-contract findings

- OpenCode local server routes explicitly map:
  - `400` bad request (validation/schema issues),
  - `404` not found (invalid `sessionID` etc.),
  - `500` unknown/internal errors.
- Basic Auth failures should be treated as auth failures (`401`/`403` class in UI mapping).

### D. Import pathway constraint (key gap now made explicit)

- OpenCode local server exposes session CRUD and message/prompt endpoints, but does **not** expose a first-party HTTP endpoint that accepts a complete imported session bundle and recreates it server-side.
- Therefore, v1 does not perform cross-server import into a different OpenCode instance.
- v1 behavior is same-server session reveal/materialization in Web UI only.

### E. OpenCode Web UI session visibility behavior (important implementation detail)

- OpenCode Web UI session list updates are primarily event-driven (`session.created`/`session.updated`), not continuous `/session` polling.
- The UI bootstrap list request is constrained (root sessions + limit + recency trimming + archived filtering + directory scoping).
- Therefore, a valid existing session can still be invisible in sidebar/session list after reload if it falls outside current UI filters.
- Since server-side changes are out of scope, v1 must include a client-side visibility sync step (defined in section 6.5).

### F. Same-server mode for v1 (normative)

- v1 does not write session data into a second destination.
- The OpenCode server remains source of truth for session existence/content.
- Userscript responsibilities in v1:
  - discover sessions via `/session` APIs,
  - trigger UI visibility update for selected sessions,
  - provide direct navigation fallbacks when sidebar filters hide valid sessions.

## 5) User Stories
1. **Discover sessions**
   - As a user, I can open an overlay and fetch all sessions from my current OpenCode instance.
2. **Reveal one**
   - As a user, I can click a specific listed session and reveal/open only that session.
3. **Reveal all**
   - As a user, I can trigger reveal for all visible sessions at once.
4. **See status**
   - As a user, I can see which reveal actions succeeded, warned, or failed.

## 6) Functional Requirements

### 6.1 Script Bootstrapping
- Provide Tampermonkey metadata block:
  - `@name`, `@namespace`, `@version`, `@description`
  - `@match` rules for target web UI pages
  - `@grant` values (`GM_xmlhttpRequest`, `GM_setValue`, `GM_getValue`, `GM_registerMenuCommand`)
  - `@connect` for allowed OpenCode host(s)
- Register menu command(s):
  - “Open Session Reveal Overlay”
  - Optional: “Configure OpenCode Endpoint”

### 6.2 Endpoint Configuration
- Configuration model:
  - `opencodeBaseUrl` (string)
  - Optional `directory` scope (maps to query/header OpenCode instance selection)
  - Optional source Basic Auth (`username`, `password`) for protected local servers
- Persist config via Tampermonkey storage.
- Validate URL format before save.

### 6.3 Session Discovery
- Triggered by overlay open and manual refresh button.
- Request session list from OpenCode endpoint:
  - `GET {opencodeBaseUrl}/session?directory=<optional>&roots=<optional>&search=<optional>&limit=<optional>`
- Source response envelope for OpenCode local server is a root JSON array (not `items`/`data` wrapper).
- No cursor/page pagination exists in current OpenCode local server routes; use `limit` and optional incremental reload strategy.
- Normalize response to required client shape:
  - `id` (required)
  - `title` (fallback: `Session {id}`)
  - `updatedAt` from `time.updated` (epoch milliseconds)
  - `summary` from session summary fields when present
  - `directory`, `parentID`, `archivedAt` (optional but retained for reveal/filter policy)
  - `raw` (full source object retained for local action context)
- Archived session handling in v1:
  - exclude archived sessions from list by default (`archivedAt` present).
  - provide explicit `Show archived` toggle to include archived rows in overlay list.
- Sort default by `updatedAt desc` where available.
- Session content may be prefetched via `GET {opencodeBaseUrl}/session/{sessionID}/message` when opening a selected session.

### 6.4 Overlay UI/UX
- Overlay panel (fixed, high z-index, keyboard accessible):
  - Header with title + close button.
  - Controls row: Refresh, Import All, Settings.
  - Bulk scope toggle: `Filtered/Visible` (default) vs `All Loaded`.
  - Archived visibility toggle: `Show archived` (default off).
  - Search/filter input by title/id.
- Sessions table/list with per-row “Import” button.
  - Label may remain “Import” in v1 UX, but behavior is same-server reveal/open.
  - Status area for logs/progress (minimal in v1: `processed / total` + final `revealed / warning / failed` counts).
  - Per-session status is deduped by `sessionId`; latest attempt replaces prior row status.
- Visual statuses for each row:
  - `idle`, `revealing`, `revealed`, `warning`, `failed`.
- Disable duplicate action while a row or bulk reveal is in progress.

### 6.5 Reveal Behavior
- **Single reveal**:
  - user clicks row reveal/import button.
  - script validates/reads source metadata using `GET /session/{sessionID}`.
  - script triggers UI visibility nudge:
    - `PATCH /session/{sessionID}` with body `{ "title": "<existing-title>" }`.
  - script optionally preloads transcript using `GET /session/{sessionID}/message`.
  - script resolves session route pattern from current app URL at runtime, then navigates using resolved pattern + selected `directory`/`sessionID`.
- **Bulk reveal**:
  - default behavior reveals only currently filtered/visible sessions.
  - optional user-selected mode reveals all loaded sessions (ignores active filter text).
  - archived rows are excluded from bulk selection unless `Show archived` is enabled.
  - in v1 this means applying the UI visibility nudge for each selected session.
  - strict sequential execution in v1 (`concurrency = 1`).
  - no automatic retry and no per-row retry action in v1.
- Explicit constraint for v1:
  - do **not** assume an OpenCode-native HTTP endpoint like `POST /session/import` exists.
  - do not implement client-side overwrite/skip conflict logic in same-server mode.
  - do not implement dry-run/preview mode in v1.
- **OpenCode Web UI visibility sync (required in v1)**:
  - After single or bulk selection confirms session exists, call:
    - `PATCH {opencodeBaseUrl}/session/{sessionID}` with body `{ "title": "<existing-title>" }`
    - Include same directory targeting context (`directory` query and/or `x-opencode-directory` header).
  - Purpose: force `session.updated` event emission so Web UI stores refresh without server-side changes.
  - If nudge fails, keep session marked available but surface a visibility warning and offer direct navigation.
- **Direct navigation fallback**:
  - If runtime route resolution fails, use canonical fallback:
    - `/{base64(directory)}/session/{sessionID}`
  - Use direct navigation when sidebar does not show the selected session immediately.
- Per-item result recorded and surfaced in UI (deduped by `sessionId`; latest attempt wins).
- Success criteria in v1:
  - source session exists and can be opened,
  - UI visibility nudge succeeds or fallback link is provided.

### 6.6 Session Reveal Contract (v1 normative)

- Input requirements per selected session:
  - `sessionID` (required),
  - `directory` (required for correct workspace routing),
  - `title` (required for PATCH no-op body).
- Required calls:
  - `GET /session/{sessionID}` (existence + metadata),
  - `PATCH /session/{sessionID}` with existing title (event nudge),
  - optional `GET /session/{sessionID}/message` (prefetch).
- Required output mapping:
  - `revealed`: exists + nudge succeeded,
  - `available-with-warning`: exists + nudge failed + deep-link provided,
  - `failed`: source session not found/auth/network/schema failure.

### 6.7 Error Handling
- Distinguish and message common failures:
  - Missing configuration
  - Unauthorized/auth failed (`401`/`403` and Basic Auth failures)
  - Network/CORS failure
  - Invalid response shape (`400` schema/validation mismatch)
  - Not found (`404` session)
  - UI visibility sync failure (session exists but OpenCode UI did not ingest update event)
- Bulk reveal continues after individual failure; produce final summary counts.
- For visibility-sync failures, use warning-level messaging and preserve `available-with-warning` status.
- v1 retry policy is fail-fast per attempt (no automatic retries, no retry button).
- CSRF handling in v1: no token flow implemented; treat `401`/`403` as auth/security failure and surface remediation guidance.

### 6.8 Security/Privacy
- Do not log tokens in console/UI.
- Store only minimal required settings in Tampermonkey storage.
- Sanitize any server-returned HTML/strings before rendering in overlay (render as text, not HTML).

## 7) Data Contracts (Initial Draft)

### 7.1 SessionListItem (normalized)
```ts
interface SessionListItem {
  id: string;
  title: string;
  updatedAt?: number;
  archivedAt?: number;
  directory?: string;
  parentID?: string;
  summary?: {
    additions?: number;
    deletions?: number;
    files?: number;
  };
  raw: unknown;
}
```

### 7.2 SessionActionResult
```ts
interface SessionActionResult {
  sessionId: string;
  status: 'revealed' | 'available-with-warning' | 'failed';
  message?: string;
  uiSynced?: boolean;
  warningCode?: 'ui-sync-failed' | 'ui-filtered-out';
  errorCode?:
    | 'source-auth'
    | 'source-network'
    | 'source-shape'
    | 'unknown';
}
```

### 7.3 SessionRevealResult (v1)
```ts
interface SessionRevealResult {
  status: 'revealed' | 'available-with-warning' | 'failed';
  sessionId: string;
  message: string;
  uiSynced: boolean;
  openUrl?: string; // deep-link fallback when uiSynced=false
}
```

## 8) UX Flow
1. User opens target page.
2. User launches overlay via menu command or floating launcher button.
3. Script loads config and requests session list.
4. Sessions display in table/list.
5. User either:
   - Clicks one session’s **Import** button, or
   - Clicks **Import All** using selected bulk scope (`Filtered/Visible` default, optional `All Loaded`).
6. Overlay shows real-time progress and final summary.

## 9) Acceptance Criteria
- Overlay opens/closes reliably without page refresh.
- Session list loads from configured OpenCode endpoint and displays at least id/title.
- Clicking a row reveals exactly that existing session and updates row status.
- Clicking Import All processes sessions according to selected bulk scope:
  - `Filtered/Visible` by default.
  - `All Loaded` when user toggles scope.
- Archived rows are hidden by default and only participate when `Show archived` is enabled.
- Overlay progress is minimal in v1: `processed / total` during run + final `revealed / warning / failed` summary counts.
- Failures are non-fatal for batch flow and clearly visible.
- Config persists across page reloads.
- Script performs post-selection visibility sync (`PATCH /session/{id}`) and reports warning (not hard failure) when sync call fails.

## 10) Edge Cases
- Empty session list (show empty-state message).
- Duplicate session IDs in source payload (dedupe by id and warn).
- Repeated reveal attempts on same session:
  - replace row status/message with latest attempt outcome (no duplicate rows).
- Session list partially malformed:
  - Skip invalid records and report count.
- User closes overlay during reveal:
  - continue in background for current page session, reopen shows latest state.
- Selected session not visible in OpenCode UI list due to root/limit/recency/archive/directory filters:
  - keep row as `available-with-warning` in overlay and provide direct open-session link.

## 11) Test Plan (for implementation phase)
- Unit tests (if script bundled in repo tooling):
  - hand-written minimal fixtures only (no captured golden payload set in v1)
  - unit-level `fetch` stubs only (no integration mock server in v1)
  - response normalization
  - session reveal result mapping
  - dedupe logic
  - latest-attempt-wins status replacement by `sessionId`
  - error mapping/user-friendly messages
- Manual browser validation in Tampermonkey:
  - ad-hoc local environment only in v1 (no shared QA environment requirement)
  - configure endpoint
  - list sessions with archived hidden by default
  - enable `Show archived` and verify archived rows appear
  - reveal single
  - reveal all with mixed success/failure in `Filtered/Visible` mode
  - reveal all in `All Loaded` mode
  - verify bulk reveal runs strictly sequentially (`concurrency = 1`)
  - verify progress display remains minimal (`processed / total` + final summary counts)
  - verify no retry button is shown in v1
  - verify failed rows stay failed until user reruns action manually
  - rerun reveal on same session and verify row updates in place (no duplicate status rows)
  - verify runtime route resolution follows current app URL pattern
  - force route-resolution failure and verify canonical fallback URL navigation works
  - verify no cross-server write/bridge dependency in same-server mode
  - verify post-selection nudge triggers OpenCode UI visibility update without hard page reload
  - verify warning + deep-link fallback when nudge fails or session remains filtered from sidebar
  - refresh and re-open overlay

## 12) Open Questions for Iteration
- No open questions in this section after current v1 decisions.

## 12.1) Implementation Knowledge Gaps Register

The following gaps must be resolved (or explicitly assumed) before implementation.

### A. Source API contract gaps
- **A1. List route + envelope**: **Resolved** (`GET /session`, root array).
- **A2. Pagination**: **Resolved** (no cursor pagination; server-side `limit`, default 100).
- **A3. Required fields**: **Resolved** (`Session` object includes `id`, `title`, `time.updated`, etc.).
- **A4. Detail fetch necessity**: **Resolved** (metadata + nudge are required; `/session/{sessionID}/message` is optional prefetch).
- **A5. Deleted/archived semantics**: **Resolved for v1** (archived hidden by default; user can include via `Show archived` toggle).

### B. Same-server reveal contract gaps
- **B1. Nudge event semantics**: **Resolved** (`PATCH /session/{id}` emits session update in OpenCode server path).
- **B2. Deep-link route stability**: **Resolved for v1** (resolve route from current app URL pattern at runtime; canonical fallback `/{base64(directory)}/session/{sessionID}`).
- **B3. Conflict semantics**: **Not applicable in v1** (server already holds source of truth).
- **B4. Replace behavior**: **Not applicable in v1**.
- **B5. Idempotency**: **Resolved for v1** (reveal calls repeat-safe; per-session latest-attempt status replaces prior row state).

### C. Auth/security gaps
- **C1. Auth transport**: **Resolved for v1** (cookie/session-first with optional Basic Auth fallback).
- **C2. CSRF policy**: **Resolved for v1** (no CSRF token flow implemented; `401`/`403` handled as auth/security failures).
- **C3. CORS behavior**: **Resolved for OpenCode local server** (browser `fetch` supported under configured origin rules).
- **C4. Token/session lifecycle**: **Resolved for v1** (no token refresh flow; user re-authenticates and reruns action after auth expiry/failure).

### D. Operational and UX gaps
- **D1. Reveal-all scope**: **Resolved** (default `Filtered/Visible`, optional `All Loaded` toggle).
- **D2. Retry policy**: **Resolved for v1** (no automatic retry, no retry button).
- **D2a. Dry-run/preview mode**: **Resolved for v1** (not included).
- **D3. Throughput limits**: **Resolved for v1** (strict sequential processing only, `concurrency = 1`).
- **D4. Long-run feedback**: **Resolved for v1** (minimal progress only: `processed / total` + final counts).
- **D5. UI cache/list staleness for existing sessions**: **Resolved for v1** by mandatory visibility sync + deep-link fallback.

### E. Testability gaps
- **E1. Contract fixtures**: **Resolved for v1** (minimal hand-written fixtures only).
- **E2. Deterministic mocks**: **Resolved for v1** (unit-level `fetch` stubs only).
- **E3. Manual verification environment**: **Resolved for v1** (ad-hoc local manual validation only).

### Gap-resolution exit criteria
- All A/B/C gaps resolved with either validated contract docs or explicit assumptions approved by product owner.
- D gaps resolved into concrete v1 behavior statements.
- E gaps resolved enough to run basic unit checks and ad-hoc local manual validation.

## 13) Proposed v1 Implementation Phases (next step)
1. Scaffold userscript + config storage.
2. Implement overlay shell + session listing.
3. Implement single-session reveal + per-row status.
4. Implement bulk reveal and summary reporting.
5. Harden error handling + UX polish.

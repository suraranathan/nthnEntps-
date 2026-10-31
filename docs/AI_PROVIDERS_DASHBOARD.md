# AI Providers dashboard

Open **AI Providers** in the existing dashboard navigation at `http://localhost:3000` after starting `npm run dev` or `npm run start` from `apps/dashboard/`. The office, team, activity and Alex chat remain available. This is the existing same-device, single-user dashboard, not a public administration service.

## Integration audit

Before this interface, Phase 2 Steps 1–4 already supplied the provider adapter registry, encrypted connection manager, protected endpoint transport, persistent model discovery/catalog, explicit verification and compatible ordered agent assignments. The existing HTTP API exposed only `/api/alex`; provider operations were CLI-only. There were no browser endpoints for connection management, catalog queries/refresh, verification or assignments.

The added `/api/ai` endpoint is a thin adapter over those existing services. It shares the existing API server, proxy, cookie sessions and origin/CSRF checks. No parallel registry, database, credential storage, discovery implementation or compatibility resolver was added. Provider storage is opened lazily; initialization failures leave Alex and the office available. Provider operations and errors never write Alex's memory/audit. Existing CLIs and the independent discovery watcher remain operational.

Alex now consumes his saved agent `01` primary through the [assigned runtime](ALEX_ASSIGNED_RUNTIME.md). The UI edits and assesses the same assignment service; saved ordered fallbacks can be used only for narrowly defined slow or provider limit conditions. The other six agents remain placeholders. Nexus is not implemented.

## Workflow

1. Add an OpenRouter, OpenAI-compatible or Ollama connection. Provider options come from the backend registry. New UI connections are disabled. Choose the appropriate public HTTPS or approved loopback network policy; configured local ports are displayed from backend rules.
2. Test the connection. Authentication/discovery results and sanitized error codes are shown; this never establishes model inference access. Enable the connection and use **Discover models** to refresh its catalog. The existing watcher also discovers enabled connections.
3. Search models by name/exact native ID and filter by provider, connection and output modality. Use **Load more models** for snapshot-bound pagination. If a refresh or verification invalidates a cursor, restart results rather than combining different snapshots. Duplicate models from different connections remain distinct routes.
4. Inspect capabilities and verification details. Advertised metadata and observed probe results are separate. Untested, unavailable, incompatible, expired and historical results do not qualify models automatically. Verify explicitly; up to five bounded requests test text, streaming, tools, structured output and system instructions. These requests may consume provider credits.
5. Choose an agent and its required capabilities. Alex always requires text and system instructions. Add compatible catalog models to the draft, reorder the primary and fallback candidates, remove unwanted candidates, and save. Every candidate is checked again by the backend. Saved assignments use optimistic revisions; conflicts require reloading the assignment. Changing agents or explicitly discarding the draft loses unsaved changes.

Connection metadata editing and credential replacement/clearing are separate operations. Changing the endpoint/network policy clears its stored credential; save that change before replacing the key. Configuration revisions invalidate previous catalog/verification eligibility, so refresh and verify again. Removal requires explicit inline confirmation and leaves historical catalog observations unavailable.

**Reload state** refreshes connection/catalog state after CLI changes or interrupted requests. **Reload assignment** reloads its current stored revision and candidates. Connection test history comes from the existing bounded audit (latest 100 audit records), so it may age out; it is labeled historical rather than a current health guarantee. Catalog refresh errors and per-model verification results retain their existing persistence semantics.

## HTTP contract

`GET /api/ai` returns a session CSRF token, backend provider definitions, safe connection metadata, latest catalog refresh statuses, supported verification capability names, allowed local ports and sanitized latest connection test history. It makes no external provider requests.

`POST /api/ai` accepts JSON with one explicit `action`. Every POST, including searches, requires the session cookie, allowed dashboard Origin, exact `Content-Type: application/json` and `X-Alex-CSRF`. Requests retain the existing 16,000-byte body bound. Browser requests use same-origin credentials and `cache: no-store`; the existing service worker excludes all `/api/` traffic.

| Action | Additional input | Existing service |
| --- | --- | --- |
| `connection.add` | `connection`, optional write-only `apiKey` | `ConnectionManager.add` |
| `connection.edit` | `id`, `revision`, `patch` | `ConnectionManager.edit` |
| `connection.credential` | `id`, `revision`, `apiKey` (string or null to clear) | `ConnectionManager.setCredential` |
| `connection.enable` | `id`, `revision`, boolean `enabled` | `ConnectionManager.setEnabled` |
| `connection.remove` | `id`, `revision` | `ConnectionManager.remove` |
| `connection.test` | `id`, `revision` | `ConnectionManager.test` |
| `catalog.refresh` | connection `id` | `CatalogService.refresh` |
| `catalog.search` | existing `query`, `agentId`, `requiredCapabilities` | `CatalogService.search` + `AgentAssignments.assess` |
| `model.verify` | `routeId`, `capabilities` | `VerificationService.verify` |
| `assignment.get` | `agentId` | `AgentAssignments.get/resolve` |
| `assignment.set` | `assignment`, expected `revision` | `AgentAssignments.set` |

Search returns the existing catalog page plus eligibility reasons for the selected requirements. It adds no inference or new catalog filtering semantics. All transport types import existing backend contracts using erased type-only imports; server implementations and dependencies are not bundled into browser code.

Service errors use stable sanitized messages/codes, with HTTP 400 for invalid requests/incompatible assignments, 404 for missing connections, 409 for stale revisions/catalog cursors or busy operations, and 503 for known vault/storage failures. Authentication, origin, content type and size checks retain the original HTTP statuses. Failed provider tests/refreshes/verifications return their structured service result so the interface can display and retain the actual failure. Unknown internal failures never expose raw errors or imply that an interrupted mutation definitely did not execute.

## Credentials and validation limits

Keys can be entered only into write-only password fields. They are sent in a protected same-origin JSON POST to the local backend, encrypted by the existing vault and never included in response contracts. Inputs clear immediately on submission (including failures), provider change, cancellation or leaving the page. No browser storage, URL parameter, chat message, source configuration or credential read/reveal endpoint is used. Stored keys cannot be viewed or repopulated. Endpoint validation, IP pinning, TLS checks, redirect rejection and response sanitization remain in the existing backend services.

Automated integration tests cover the actual browser client → HTTP API → Phase 2 services path, Vite proxy reads/writes, protected sessions/CSRF, input limits, safe failures, credential redaction/encryption, metadata and credential revisions, discovery/search/pagination, verification, eligibility, assignment/fallback ordering and unchanged Alex memory. Tests use isolated temporary stores and mocked provider responses; they do not establish live provider availability. No real credentials or local model service were supplied, and no external model verification was performed. Interactive browser/device visual QA is unavailable in this environment.

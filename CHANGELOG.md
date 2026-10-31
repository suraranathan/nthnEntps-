# Changelog

## 2026-10-31 — GitHub Actions Android APK build

- Committed and pushed the approved 95-file Capacitor, dashboard, AI Providers and Alex snapshot as `c338400`; ignore and staged scans found no private configuration, signing key or generated build artifact.
- Added a private-repository workflow for a Node 24/JDK 21 debug APK build on Ubuntu 24.04, with tests, typechecks, production build, Capacitor sync and an APK-only seven-day artifact. Added download and installation guidance. The cloud build result is pending.
- The first cloud run stalled in the Vite dev-server smoke test before Gradle. Closed test HTTP connections explicitly and bounded the workflow test step to three minutes before retrying.
- The bounded retry showed 52 passing tests before the Vite visibility test stayed pending; changed the test runner to run files serially to avoid overlapping Vite servers on the smaller cloud runner.
- A serial cloud run stalled at the same Vite source-transform smoke test. Replaced only that live transform assertion with source and plugin checks; separate integration tests still exercise the live Vite proxy and the production build compiles all frontend source.

## 2026-10-31 — Capacitor Android integration

- Added Capacitor 8 and a native Android project for nthnEntps, retaining the existing React/Vite dashboard, AI Providers, API and Alex.
- Configured the WebView for the same-phone Termux dashboard at `127.0.0.1:3000`, with existing `/api` proxy to the loopback backend on port 3001; scoped Android cleartext access to loopback and retained API session/CSRF protections.
- Added web sync/debug APK scripts and Android build, install, security and live-reload documentation. No keys or backend service are bundled in the app; no GitHub push.
- Verification: 113 tests, typecheck, production build and Capacitor sync pass. Same-phone HTTP checks: dashboard/Alex/AI 200; missing CSRF and LAN Host 403. Native Gradle build was attempted but no JDK is installed, so no APK was produced and installed-WebView testing remains open.

## 2026-10-30 — Alex assigned OpenRouter runtime

Alex now uses his saved Phase 2 agent-01 assignment through a server-only OpenRouter provider adapter. Startup attaches that adapter to the existing ModelRouter; before every Alex request it checks the exact assigned route, enabled connection, current revision, 24-hour verification and required text/system-instruction evidence. The existing runtime still builds Alex's original system instructions, memory, history, authored context and approved Sophia queue, then sends them through ConnectionManager.inferenceProbe with its encrypted credential, protected endpoint/IP/TLS policy and bounded response handling. No key reaches the browser, logs or Alex's prompt. Existing environment providers and manual selection remain available. Model replies retain provider/model attribution and full transcript continuity.

Automatic switching is limited to three consecutive responses taking at least 12 seconds, or observed OpenRouter key allowance at or below 10% of a positive key limit, or a provider 429 rate-limit response. The key allowance comes from OpenRouter's authenticated /key endpoint; deprecated request-count metadata is not used. A switch is considered only among saved ordered fallback route IDs. Before use, the adapter reassesses eligibility, refreshes a stale catalog when needed, and explicitly verifies required capabilities when evidence is missing/expired. It never selects a newer, cheaper or more capable model for that reason alone, and never switches on an unrelated model failure. The switch occurs before Alex builds the next system prompt, records a local event, and displays a notification in chat with the reason. On 429, the failed request is reported honestly; the next request may switch. If no fallback is eligible, Alex reports the problem instead of claiming online status. A generic provider failure also remains an error.

Real OpenRouter validation: the saved primary assignment is aion-labs/aion-2.0. A protected dashboard POST /api/alex chat request returned HTTP 200, status online, that exact model, and a genuine model-generated Alex reply identifying him as employee 01 and Personal Communicator. The assignment currently contains one candidate, so no real fallback switch was possible. The older conversation and identity files were preserved. Existing Sophia queue/delegation controls remain, but Sophia's adapter is still unavailable; no executable model tools were added.


## 2026-10-30 — Correct OpenRouter assignment eligibility reasons

Inspection of the real OpenRouter registry confirmed an enabled revision-2 connection, accepted authentication, successful current discovery and 653 correctly scoped catalog routes. Exactly 650 had no verification; two recorded INVALID_RESPONSE and one (aion-labs/aion-3.0) passed text/streaming but received MODEL_UNAVAILABLE on the tools probe, before system instructions ran. The connection's inference health records the last probe, not availability of every model.

Root cause of the blanket unavailable message: AgentAssignments.assess checked route.access.state !== 'verified' before missing verification, so discovery-only listed/account-listed routes all returned MODEL_UNAVAILABLE. Fixed eligibility reasons to distinguish disabled connections, stale/failed catalogs, missing/current-revision verification, individual probe failures, expiry and capability mismatch. Every eligibility gate remains enforced. The UI now explains the actual reason and labels connection inference health as the last probe.

A second integration issue was that the UI always requested all five probes, regardless of the selected agent's requirements. An unrelated optional-capability failure could stop verification before required system instructions. The UI now explicitly verifies selected required capabilities (text is always tested); additional requirements can be selected to test more. No failed capabilities are promoted, no failed provider response is ignored, and new observations leave unrequested capabilities untested.

Real validation on 2026-10-30: aion-labs/aion-3.0 passed new text and system-instruction requests through the existing vault and protected transport; compatibility assessment returned OK for Alex's requirements. No assignment or Alex runtime selection was changed. The earlier failures remain in history; no other model was claimed verified. Raw credentials/responses were not logged. No Nexus or GitHub push.

Validation: 113 full tests passed, the focused 32-test verification suite passed after a fixture type correction, frontend/server typecheck and production build passed, and git diff --check passed. The real dashboard request returned HTTP 200 and status online through aion-labs/aion-2.0. The existing large Vite bundle warning remains. No real automatic switch was observed because no fallback is saved.

Validation: all 111 tests pass, frontend/server typecheck and production build pass, and git diff --check passes. Restarted the running backend to activate the eligibility change. A protected HTTP query of the live dashboard returned 653 routes with zero provider/connection/revision association mismatches: 649 UNVERIFIED, two INVALID_RESPONSE, one MODEL_UNAVAILABLE and one OK at the final check (live eligibility counts changed during the investigation). No bulk verification or assignment was performed. The existing large-bundle warning remains.


## 2026-10-30 — Fix Android AI Providers fetch invocation

The Android “Failed to execute 'fetch' on 'Window': Illegal invocation” error was caused by AiClient storing native fetch and invoking it as this.#fetch(...). That method call supplied the AiClient instance as the receiver instead of Window, so browser receiver validation failed before the request reached /api/ai. The resulting API-unavailable UI was a client-side failure, not a backend startup, route, authentication or cache error. Inspection found Alex's existing fetch calls use direct global invocation and do not share this defect.

AiClient now binds both default and injected transports to globalThis. Existing request URLs, session cookies, CSRF headers, origin checks, timeouts, no-store behavior and credential handling are unchanged. Added a receiver-enforcing browser-compatible regression that reproduces the old TypeError before HTTP, then exercises default/injected clients, connection loading and a protected credential write against the actual local API in isolated fixtures. Earlier arrow-function mocks and Node fetch did not enforce Window receiver semantics, explaining why they passed. No Alex, design, Capacitor or backend security changes; no GitHub push.

Validation: all 109 tests pass; frontend/server typecheck and production build pass; git diff --check passes. The live dashboard on localhost:3000 serves the binding fix, loads connection metadata and accepts a CSRF-protected catalog query through the client with a browser-style receiver check. A missing-CSRF request still returns 403. Live checks made no provider mutations or external model calls. Direct Android browser interaction remains unavailable; the Window receiver requirement is reproduced by the regression fixture. The existing large-bundle warning remains (1,175.54 kB / 326.97 kB gzip).


## 2026-10-30 — Fix stale dashboard navigation in development

Investigation confirmed the running Vite process uses apps/dashboard and serves App.tsx with the AI Providers button/import/conditional page mount, plus desktop/mobile navigation CSS. The page has no permission, credential or feature-flag visibility gate. The defect is the production PWA worker's broad cache-first handling of scripts/styles: after switching the same origin to development it can cache unchanged /src URLs and keep serving old navigation. Development previously neither removed that worker nor served valid JavaScript at /service-worker.js (Vite returned the HTML fallback). A regression test reproduces stale navigation under that policy. The user's browser cache cannot be inspected here, so attribution of the reported screen to that reproduced defect remains an inference.

Fixed development HTML to remove only this dashboard's worker and shell caches before a one-time reload. Development now serves a no-store retirement worker, and production caching is restricted to its precache asset list so it cannot capture development modules. Existing production offline support, UI/navigation, Alex and all provider services are preserved. The running server has loaded the fix; reload http://localhost:3000 to receive it. No GitHub push.

Validation: all 108 tests pass, frontend/server typecheck passes, production build passes and git diff --check passes. Three new regressions cover stale development-module caching, scoped worker/cache removal without reload loops, and actual Vite navigation/component/CSS/worker responses. Parallel Vite test fixtures now allow available-port selection to avoid collisions. Production frontend asset hashes and the existing large-bundle warning are unchanged. Interactive browser/device confirmation remains unavailable.


## 2026-10-30 — AI Providers management interface

- Added AI Providers to the existing desktop/mobile navigation and dashboard design, with add/edit/test/enable/disable/remove controls for all three existing provider types, explicit discovery and write-only credential replacement/clearing. Password inputs clear on submission, and saved credentials are never returned or revealed.
- Added searchable, filterable, paginated model routes with provider/connection identity, listed versus tested capabilities, verification timestamps/status/expiry and sanitized failure results. Added explicit model verification and compatible primary/ordered fallback assignment controls with the existing revision and capability requirements.
- Closed the missing dashboard HTTP integration with `/api/ai`, a thin adapter over the existing Phase 2 services. Reused local origin/session/CSRF protections and the Vite proxy; isolated lazy provider initialization and provider errors from Alex's startup and memory. No parallel backend, runtime model switching, automatic inference failover, Nexus or dependency added.
- Added seven transport/integration tests and dashboard setup/API documentation; updated project status. All 105 tests, frontend/server typecheck, production build and whitespace checks pass. Existing large 3D-bundle warning remains (1,175.51 kB minified / 326.96 kB gzip). Live provider and interactive browser/device validation remain unavailable. Alex identity/personality, runtime/memory/chat and existing features are preserved; nothing pushed to GitHub.

## 2026-10-30 — Phase 2 Step 4: explicit model verification and compatible assignments

- Added explicit provider/account/native-model inference verification with persistent timestamps, revision-bound results, capability observations and sanitized auth/credit/rate-limit/provider error handling. Discovery never establishes verified access.
- Added separate OpenAI-compatible/OpenRouter and Ollama probes for text, streaming, tools, simple structured output and system instructions. Reused encrypted credentials and protected endpoint transport; no raw responses/keys enter stored results or frontend responses.
- Added revision-checked agent assignments with multiple ordered compatible models/fallback candidates, evidence expiry and resolution rejection reasons. Alex (01) requires text and system instructions; identity/personality, memory and runtime remain unchanged. No Nexus, dashboard redesign, automatic inference failover or GitHub push.
- Added 29 verification/assignment tests and updated provider/catalog documentation. All 98 tests, frontend/server typecheck, production build and CLI help pass; frontend hashes and the existing bundle-size warning remain unchanged. No live external models were verified: no real credentials/account routes were configured. Automated successes are mocks/local HTTP fixtures.

## 2026-10-30 — Phase 2 Step 3: automatic discovery and unified catalog

- Added protected discovery for all enabled registry connections: OpenRouter user-filtered/all-modality offset pages, generic advertised pagination and Ollama local tags. Preserved exact model IDs and separate account/provider routes; source listings never become verified access claims.
- Added a private SQLite catalog with searchable/filterable snapshot pages, source capabilities/metadata, refresh/error history, leases, atomic staging/publication and retained unavailable historical routes. Failed/partial refreshes retain the last complete catalog; only complete success retires unseen listings.
- Added catalog watch/sync/refresh/search/get/status CLI commands and automatic dev/preview watcher startup. New/changed connections are detected, disabled ones skipped, provider failures isolated and retries backed off. Catalog-worker failure leaves Alex/UI running; shutdown cleanup is bounded.
- Extended the existing protected transport with allowlisted listing queries/Link metadata and a separate 16MiB discovery response bound, retaining the 1MB management-probe bound. Rejects unsafe pagination and known credential echoes before persistence. No total model-count cap, paid inference, model assignment, Nexus or dashboard redesign.
- Preserved existing Alex source/frontend/API/provider/memory and all prior tests. Added comprehensive discovery/catalog/runner tests and setup/architecture documentation; no dependencies added.
- Verification: all 69 tests pass (44 existing + 25 new); frontend/server typecheck, production build and catalog help smoke check pass. Existing asset hashes and bundle warning remain unchanged (1,151.00 kB minified / 319.93 kB gzip). Live external provider validation remains unconfigured.

## 2026-10-30 — Phase 2 Step 2: provider connection management

- Added independent SQLite-backed connection management and a backend CLI for add/edit/get/list/test/enable/disable/remove, credential replacement/clearing and audit. Supports multiple OpenRouter, OpenAI-compatible and Ollama accounts/endpoints, disabled by default.
- Added AES-256-GCM encryption with a separate private master key, randomized nonces, connection/revision binding, key verification, strict storage permissions and transactional persistence. Credential input uses private stdin only; outputs/audits/errors never include provider keys.
- Added provider-specific adapters and shared SSRF protections: endpoint validation, explicit loopback approval, all-answer DNS checking/IP pinning, TLS hostname verification, redirects rejected and bounded requests. Endpoint edits clear credentials; revision checks reject stale writes/test results.
- Added 21 management/security tests and connection-management documentation. Added only the `providers` package script; no dependencies or existing runtime startup behavior changed.
- Preserved Alex's frontend/backend/provider/memory/API and all existing tests. No browser administration endpoint, dashboard redesign, catalog implementation, model assignment activation or Nexus.
- Verification: all 44 tests, frontend/server typecheck, production build and CLI help smoke check pass. Existing bundle warning remains (1,151.00 kB minified / 319.93 kB gzip). External account validation still requires real provider credentials; no external connection success is fabricated.

## 2026-10-30 — Phase 2 Step 1: baseline and provider contracts

- Inspected modified/untracked work and preserved the completed Alex/office application in local commit `8dd6f11`, with recovery tag `phase2-step1-baseline`. Captured 39 versionable files; credential-pattern scan found no matches and ignored private/generated files were excluded. No push or destructive Git operation.
- Added isolated schema-versioned provider, connection, model, route, paginated catalog, discovery/evidence, pricing/limits/usage, inference and explicit-assignment contracts. Reused existing `ModelProvider`, `ModelMessage` and `ModelRouter` through type-only compatibility seams.
- Added a pure lossless route-key helper that distinguishes connections, exact native model IDs and explicit/default upstreams, without model-count truncation.
- Added deterministic route/compatibility tests and a compile-time guard keeping plaintext keys outside safe connection metadata. Documented contract semantics, future security/persistence obligations and the recovery baseline in `docs/AI_PROVIDER_SYSTEM.md`.
- Preserved all existing Alex/frontend/backend/configuration source files. No runtime wiring, database, provider connection, dashboard redesign or Nexus implementation was introduced.
- Verification: all 23 tests pass (16 unchanged Alex tests + 7 contract tests); frontend/server typecheck and production build pass. Existing bundle-size warning remains (1,151.00 kB minified / 319.93 kB gzip).

## 2026-10-30 — Alex, Personal Communicator runtime

- Added Alex's versioned identity and original witty, context-aware personality instructions, with serious-mode behavior, grounded humor, explicit AI/capability boundaries and a shared authoritative seven-person roster/office context. No predefined joke bank or canned conversational fallback.
- Added a local Node 24+ API, real OpenAI-compatible/Ollama transports, configured model routing and optional discovery. Provider switches preserve context; no connection is marked online until actual inference succeeds. Nexus remains a future integration seam.
- Added schema-validated atomic persistent memory for preferences, full transcript, user-reported project context, relationships, inside jokes and temporary notes; recent/relevant prompt context is bounded. Private local storage, PID locking, write-failure rollback and sanitized audits make state observable.
- Connected the existing Alex profile/avatar to responsive chat, model/state display, memory/preferences, manual briefings, real event/audit logs and an explicit Sophia request/clarification queue. Six other employees remain placeholders. The original office, camera, dashboard panels and sample activity remain available.
- Added opt-in proactive model-generated updates/daily briefings, timezone/quiet-hour/interval controls, persistent success-only event/day deduplication, failure backoff and an unread badge. Scheduling requires the local server to stay running; no push integration is claimed.
- Added a typed unavailable Sophia adapter/correlated update contract. Queued requests are explicitly user-approved for local storage and remain undelivered. No consequential tool/command executor or Agent 02 implementation was added.
- Secured API host/origin/session/CSRF boundaries, bounded payloads/timeouts, server-only secrets and configured provider endpoints. Preserved browser Host in dev/preview proxy; denied private memory/env files from Vite static access and excluded API traffic from PWA caching.
- Combined dev/production-preview scripts now run the dashboard and loopback agent server together. Added server/test typechecking, Node types and detailed setup/architecture documentation.
- Verification: typecheck, 16 deterministic tests and production build pass. Dashboard/API live smoke checks show truthful offline state and HTTP 503 for unconfigured inference. Vite retains the existing large-bundle warning (1,151.00 kB minified / 319.93 kB gzip).
- Configuration remains required: no real provider credentials/model/local model service was supplied, so live AI inference, humor/personality quality and browser/mobile interaction remain unverified. See `apps/dashboard/.env.example` and the dashboard README.

## 2026-10-30 — Architectural office reconstruction

- Rebuilt the scene as a furnished 18 × 14 architectural cutaway, replacing the oversized layout with an upper-left private office, lower-left eight-seat conference room, connected four-desk central bench, upper-right product office, and lower-right platform area.
- Assigned Alex to the left private office, Victor/Daniel/Marcus/Emma to the shared bench, Sophia to the upper-right office and Oliver to the lower-right workstation. Preserved all seven IDs, full roles, profile selection and placeholder status.
- Added cream walls with thickness/skirting, large framed windows, glass partitions, inward-opening doors and a labeled two-meter main entrance connected to clear central circulation. Repositioned reception and visitor seating beside the entrance.
- Added beveled furniture, five-spoke chair bases/casters, refined avatar details, conference furnishings, detailed cabinetry, populated bookcases, printers/coffee facilities and plants. Walnut plank textures include fine grain and floor bump detail.
- Reworked lighting and camera overview for the new footprint. Shared static geometry/materials, instanced books/contact shadows, local procedural textures, the existing DPR cap and one shadow map keep the reconstruction bounded for mobile; device performance is not measured.
- Updated room/door inspection and retained dashboard panels, employee/workstation interactions, rotation, zoom, top view and reset. No dependencies, downloaded assets or real AI integrations were added.
- The references directory is empty; implemented from the written specification. Browser/WebGL visual review is unavailable in this environment.
- Verification: final `npm run typecheck` and `npm run build` pass. Vite retains the existing large-chunk warning (1,137.63 kB minified / 315.89 kB gzip).

## 2026-10-30 — Complete furnished environment and visible employees

- Retained the spacious footprint and required desk-cluster arrangement; focused on furnishing and detailing the existing environment.
- Reworked all seven seated characters with visible faces, distinct styling, legs/shoes, ergonomic chairs, full role/placeholder labels, and individual head/hand idle motion. Corrected Sophia and Marcus role labels to Product Manager and Lead Developer.
- Added reception lounge furniture, meeting AV wall/credenza, populated bookshelves, coffee/printer counter, presentation wall, work-area rugs, desktop computers, planters, and architectural trim.
- Added smooth camera focus when inspecting employees/desks; Reset clears inspection and restores overview. All existing profile, room, door, gesture, and dashboard controls remain available.
- Shared static geometry/materials and instanced books/foliage keep added detail lightweight; no external asset downloads or dependencies.
- Verification: `npm run typecheck` and `npm run build` pass. Vite retains the large bundle warning (about 1.14 MB minified / 316 KB gzip).

## 2026-10-30 — Spacious upper-left and center-left workspace

- Expanded the office from 18 × 14 to 24 × 18 units, retaining realistic desk and chair dimensions.
- Positioned a connected three-desk cluster at upper-left and a connected two-desk cluster directly below it at center-left, with a clear shared aisle. Kept one independent station at each of upper-right and lower-right.
- Expanded the two enclosed left rooms, glazing, dark wood floor, and perimeter storage placement to suit the larger footprint; retained selectable doors and all seven employee identities.
- Added viewport-aware camera framing for narrow Android screens while retaining the existing rendering limits and interaction controls. No new dependencies or external assets.
- Verification: `npm run typecheck` and `npm run build` pass. The existing large bundle warning remains (about 1.14 MB minified / 314 KB gzip).

## 2026-10-30 — Enlarged office and connected desk clusters

- Enlarged the floor from 12 × 10.8 to 18 × 14 units without scaling workstation furniture.
- Arranged five light-colored desks in two connected clusters (3 + 2), with separate upper-right and lower-right employee stations, using the supplied written reference arrangement.
- Preserved the two enclosed left rooms and interactive doors; added dark wood flooring, perimeter cabinets, shelving, and wall details while keeping clear aisles.
- Updated camera framing, zoom bounds, lighting coverage, and room hit areas for the larger layout; preserved names and all dashboard interactions.
- Verification: `npm run typecheck` and `npm run build` pass. Vite retains the large bundle warning (about 1.14 MB minified / 314 KB gzip).

## 2026-10-30 — Rectangular floor-plan redesign

- Used the supplied spatial description: two enclosed left-wing rooms stacked above/below a shared wall, and a large open workspace to the right.
- Reused meeting and reception furnishings inside the left rooms; added separate 1.1m door openings with selectable open glass doors facing the shared aisle.
- Clustered all seven named employee stations in the right wing with chair clearance, row walkways, and a front collaboration area. Preserved employee, workstation, room, and camera interactions.
- Kept procedural materials, existing mobile rendering limits, and placeholder data.
- Verification: `npm run typecheck` and `npm run build` pass. The existing large bundle warning remains (about 1.13 MB minified / 314 KB gzip).

## 2026-10-30 — Interactive office controls

- Added employee profile inspection with name, role, placeholder status, and workstation assignment; desk clicks show assigned employee and equipment.
- Added contextual inspection hotspots for reception, meeting room, and collaboration area while preserving existing dashboard panels.
- Added one-pointer orbit, pinch/wheel zoom, click-versus-drag suppression, and reset-camera control. Gestures are attached only to the office canvas.
- Added animated employee selection rings and hover feedback for desks and room zones; retained subtle employee idle motion.
- Verification: `npm run typecheck` and `npm run build` pass. Vite reports the large 3D bundle warning (about 1.13 MB minified / 313 KB gzip).

## 2026-10-30 — Premium office scene

- Expanded the existing Three.js scene with a textured wood floor, full-height glass windows, glass meeting room, ceiling details, exterior skyline, reception desk and nthnEntps identity, and central collaboration furniture.
- Reworked the seven existing workstation components with office chairs, detailed monitors, procedural keyboard screens, desk accessories, and distinct placeholder avatars/nameplates.
- Added subtle idle motion, enabled soft shadows, capped render pixel ratio for mobile, and kept all scene textures procedural with no external 3D downloads.
- Preserved selectable employee IDs, desk positions, dashboard panels, and camera controls.
- Verification: `npm run typecheck` and `npm run build` pass. Vite retains the large bundle warning (about 1.13 MB minified / 312 KB gzip).

## 2026-10-30 — Placeholder employee names

- Replaced the seven numbered placeholder labels with Alex, Victor, Sophia, Daniel, Marcus, Emma, and Oliver and their specified role titles.
- Updated the selected-desk card to show the matching employee name and role; selection IDs, desk positions, and layout are unchanged.
- Verification: `npm run typecheck` and `npm run build` pass. The build retains the existing large 3D bundle warning (about 1.1 MB minified / 307 KB gzip).

## 2026-10-30 — Android PWA setup

- Configured Vite development and production preview to bind to `0.0.0.0:3000` with strict port handling; preserved the production `start` script.
- Added a web app manifest, 192px and 512px Android icons, and production service-worker registration.
- Added build-time app-shell precaching. Updates activate the new cache and remove old dashboard caches; offline navigations fall back to the cached shell.
- Documented the Termux launch and Android browser installation steps.
- Verification: `npm run typecheck` and `npm run build` pass. The generated manifest icons have valid PNG headers and declared dimensions; the build's worker contains the app asset precache.
- Build still reports the existing large 3D bundle warning (about 1.1 MB minified / 307 KB gzip).

## 2026-10-30 — Dashboard foundation

- Added a standalone Vite + React + TypeScript dashboard under `apps/dashboard/`.
- Added an interactive Three.js office scene with seven selectable placeholder positions, camera view/zoom controls, and responsive team, task, and activity panels.
- Documented local setup and the placeholder-only scope.
- Verification: `npm run typecheck` and `npm run build` pass in `apps/dashboard/`.
- Build note: Vite reports a 1.1 MB minified JavaScript bundle (307 KB gzip), mostly due to the 3D runtime; chunking or deferred scene loading can reduce the initial download later.

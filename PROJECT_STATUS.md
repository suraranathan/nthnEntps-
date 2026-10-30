# Project status

Updated: 2026-10-30

## Phase 2 — Step 2: provider connection management

Implemented independent backend connection management for multiple OpenRouter, OpenAI-compatible and Ollama accounts/endpoints. The local CLI (`npm run providers -- help`) supports add, edit, get/list, explicit test, enable/disable, credential replace/clear, remove and sanitized audit. SQLite persists metadata and encrypted credentials in `apps/dashboard/.local/ai/`, separate from Alex's memory; transactions and expected revisions prevent lost updates and stale test results. New connections default to disabled.

API credentials use AES-256-GCM with random nonces and connection/revision-bound authenticated data. A private backend master-key file is generated separately from the database; missing/wrong keys, unsafe permissions and symlinked storage fail closed. Keys are accepted only via private redirected stdin, never arguments/browser code or returned metadata. Endpoint/network edits clear old credentials. The only package-script change is adding `providers`; no dependency was added.

SSRF protection combines explicit public/loopback policies, provider-specific endpoint constraints, private/metadata address blocking, all-answer DNS validation, IP-pinned requests, original-host TLS checks, approved local ports, redirect rejection and bounded requests. Tests distinguish key acceptance from discovery/inference: inference remains untested. No public administration HTTP endpoint or dashboard UI was added. Alex's existing source, provider selection, JSON memory, API, controls and tests are unchanged; there is no Nexus or agent-routing activation.

Validation: all 44 tests pass (16 unchanged Alex tests, 7 unchanged contract tests and 21 management/security tests). Frontend/server typecheck, production build and CLI help smoke check pass. Vite retains the existing large-bundle warning (1,151.00 kB minified / 319.93 kB gzip). Git comparison confirms Alex and existing frontend/backend/startup configuration are unchanged.

See [Provider Connection Management](docs/PROVIDER_CONNECTIONS.md) for usage, backup/recovery and security limits. Real external credentials/local model services were not configured; external connection success is not claimed. Next: paginated model discovery and a searchable catalog, reusing these protected connections.

## Phase 2 — Step 1: provider contracts

The existing work was inspected and preserved in local baseline commit `8dd6f11`, tagged `phase2-step1-baseline`, before source changes. This captures 39 versionable files, including the completed Alex/office implementation. Private memory, credentials, dependencies and build output were excluded; no existing work was discarded and nothing was pushed.

New isolated contracts in `apps/dashboard/server/ai/contracts.ts` distinguish provider definitions, account/endpoint connections, exact model routes, a searchable paginated catalog, metadata evidence, commercial/usage observations, and explicit agent assignments. They reuse Alex's existing `ModelMessage`, `ModelProvider` and `ModelRouter` types without changing the existing classes. A pure route-identity helper preserves duplicate provider/account/upstream access routes and exact native model IDs. No new module is wired into production; Alex, dashboard, API/configuration and existing memory are unchanged.

Validation: all 23 tests, frontend/server typecheck and the production build pass. The existing 1,151.00 kB minified / 319.93 kB gzip bundle warning remains. Git comparison confirms existing application source/configuration and Alex tests match the recovery baseline.

Step 1 defines schemas and compatibility seams only. There is no new database, credential store, discovery worker, provider-management endpoint, actual assignment/resolver, live connection or Nexus implementation. See [AI Provider System contracts](docs/AI_PROVIDER_SYSTEM.md) for field semantics, security requirements, baseline recovery and next steps.

## Agent 01 — Alex

Alex's implementation now includes a loopback Node 24+ runtime, original model-independent personality/identity instructions, real OpenAI-compatible and Ollama HTTP transports, a provider router seam for future Nexus, persistent structured memory and a dashboard chat attached to his existing employee profile/avatar. UI states distinguish offline, thinking, online (last inference succeeded) and errors; selected provider/model and per-reply metadata are visible. No fixed joke bank or simulated chat fallback exists.

Memory separates versioned identity, explicit communication preferences, timestamped conversation, user-reported project notes, team relationships, real shared inside jokes and temporary task notes. Local atomic JSON persistence survives restarts/provider changes; schema validation rejects corrupt stores and a PID lock prevents duplicate runtimes. Recent/relevant context is bounded, so this is not perfect recall. Notes and preferences are explicitly user-managed rather than silently inferred as verified facts.

Optional model-generated proactive updates and daily briefings are off by default. Settings control humor, quiet hours, timezone, briefing time and minimum notification interval. Real local event deduplication, success-only delivery markers, retry backoff and an in-app unread badge limit spam. The server must remain running; there is no OS push service. The project document and authored office/team context are supplied explicitly to Alex, with no implied camera perception or live colleague telemetry.

Sophia is not operational. A typed unavailable adapter and correlated update contract are provided, plus a user-approved local request/clarification queue. Requests remain awaiting adapter, with no invented replies or task progress. The queue checkbox approves local storage only. No arbitrary command/tool/deployment executor is installed; future consequential actions require independent server-enforced permission and approval.

Security includes server-only environment credentials, configured provider URLs/models, HTTPS for external providers, no redirect following, bounded inputs/outputs/timeouts, single-flight generation, sanitized error/audit records, localhost host/origin restrictions, HttpOnly SameSite session cookies and CSRF validation. Vite preserves the browser Host and explicitly denies private memory/environment files from static serving. This is a local single-user runtime, not authenticated public hosting. Memory is private local plaintext, not encrypted storage. The PWA excludes API traffic from caching.

**Current connection:** no provider/model credentials or local model service were supplied. Alex is correctly offline; a real request through the dashboard returns HTTP 503 with a configuration error and no fabricated reply. Configure `apps/dashboard/.env.server` from `.env.example`, restart, then use Settings → Test real connection. Live inference and subjective personality quality have not been tested. Six colleagues remain placeholders; Agent 02 was not implemented.

Setup and detailed contracts: [dashboard README](apps/dashboard/README.md), [Alex architecture](docs/ALEX_ARCHITECTURE.md).

## Dashboard and office reconstruction

`apps/dashboard/` retains React, TypeScript, Vite, Three.js and React Three Fiber. The office has been rebuilt as an 18 × 14 architectural cutaway with a warm walnut plank floor, cream masonry, thick walls and skirting, large rear windows, framed glass partitions, open doors, and a recognizable two-meter main entrance. Camera-facing exterior walls are cut down for visibility; the roof is omitted and thin ceiling luminaires remain visible.

The written reconstruction specification was used: the workspace `references/` folder contains no reference images, so visual correspondence to the hand-drawn and realistic images has not been verified.

## Current floor plan

- Upper-left: enclosed private working room for Alex, with desk, computer, chair, rear cabinetry, tall bookcase and a separate inward-opening door.
- Lower-left: enclosed conference room with a long rectangular table, eight upholstered chairs (three per side and one at each end), presentation display and its own door. The divider between the two left rooms is solid.
- Central-left: four connected desks for Victor, Daniel, Marcus and Emma, arranged as two facing pairs with a shared acoustic screen and cable spine. A west aisle reaches both left rooms; the central north/south aisle stays open.
- Upper-right: Sophia's product office, with its own glazed partition, door and rear storage.
- Lower-right: Oliver's platform workstation, distinguished by low partitions, populated tall shelving, printer/coffee facilities and perimeter storage.
- Entrance: south-side opening leads directly into the center aisle. Reception counter, computer, visitor sofa and coffee table sit to its left.

All seven original employee IDs, names and full roles remain attached to dedicated desks, computers, keyboards, mice and seated 3D avatars. The avatars retain individual hair/accessories, facial details, clothing, shoes and subtle head/hand motion. Ergonomic chairs now have rounded upholstery and five-spoke wheeled bases. Names, roles and current state remain visible on camera-facing labels; Alex uses runtime state and six colleagues remain placeholders.

## Rendering and interactions

Furniture includes beveled tabletops/upholstery, monitor stands, cabinet fronts/handles, books, desk accessories and leaf-shaped plant foliage. A deterministic local canvas texture provides plank seams and wood grain, also used for subtle floor bump detail. Warm window daylight, a fill light, one soft shadow map and an instanced soft contact-shadow layer provide depth beneath furniture. Ceiling fixtures have illuminated diffusers.

Employee/profile selection, desk inspection, hover feedback, room/door inspection, camera focus, one-finger rotation, pinch/wheel zoom, top view and reset remain connected to the existing dashboard panels. Room inspection text and hit areas describe the new floor plan. Android rendering retains the 1.3 DPR cap, low-power renderer preference and 1024px shadow map. Static architecture/furniture reuse geometry and materials; books and soft contact patches use instancing. The office reconstruction added no external 3D assets or runtime dependencies; the Alex integration adds Node development types. Device frame rate has not been measured.

## Scope and limitations

- Alex has a real model integration/runtime but remains unconfigured. The six other employees, original task counts and activity panel remain sample placeholders. No authenticated multi-user deployment or live Sophia adapter is configured.
- The existing PWA manifest, icons and production service-worker app-shell caching remain available. AI chat still requires the local server and configured provider.
- Run commands from `apps/dashboard/`. Development and production preview use `0.0.0.0:3000` with strict port selection; the combined scripts also start the API on `127.0.0.1:3001`.
- No browser/WebGL automation is available in this environment. Render appearance, touch interaction and Android frame rate still need visual/device review.

## Verification

`npm run typecheck` (frontend + backend/tests), `npm test` (44 deterministic tests: 16 unchanged Alex tests, 7 contract tests and 21 management tests) and `npm run build` pass. The production bundle retains Vite's existing large-chunk warning (1,151.00 kB minified / 319.93 kB gzip). Live dashboard/API smoke checks verify the unconfigured/offline path and private-memory access denial. No live provider inference, browser interaction or Android device performance evaluation was possible.

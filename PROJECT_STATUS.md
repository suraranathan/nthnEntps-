# Project status

Updated: 2026-10-31

## GitHub Actions Android build

The prepared 95-file Capacitor/dashboard/AI/Alex snapshot was committed as `c338400` and pushed to `origin/main` after staged whitespace and secret-exclusion checks. A private-repository Android debug APK workflow is configured for `main` pushes and manual runs with read-only source access, Node 24, JDK 21, tests, typechecks, production build, Capacitor sync, Gradle `assembleDebug`, and a seven-day APK-only artifact. The first cloud run reached the Vite smoke test and stalled during server shutdown, so it was cancelled before Gradle; that test now explicitly closes HTTP connections, and the workflow bounds the test step to three minutes. Artifact verification is pending.

## Capacitor Android app

Integrated Capacitor 8 and added the Android project for the existing dashboard (`com.nthnentps.dashboard`, display name nthnEntps). The WebView uses the same-phone Termux dashboard at `http://127.0.0.1:3000`; Vite proxies `/api` to the existing backend bound to `127.0.0.1:3001`. Android grants `INTERNET` and scopes its cleartext exception to loopback. Source remains editable in Termux/Codex, with web sync and debug APK scripts. No provider secret is configured in Capacitor or Android resources. The backend must stay running in Termux; live reload uses the existing Vite dev server.

Validation: all 113 tests pass, frontend/server typecheck passes, Vite production build passes, and `cap sync android` copies the built dashboard. A same-phone Termux smoke run returned HTTP 200 for the dashboard, `/api/alex`, and `/api/ai`; missing-CSRF POST and LAN Host requests returned 403. The first `./gradlew assembleDebug` attempt stopped because no JDK was installed at that time; OpenJDK 21 is now installed, but Android SDK tools remain absent and no APK has been generated. Direct installed-WebView checks remain pending. See [build and connectivity](docs/ANDROID_CAPACITOR.md). Existing dashboard, AI Providers, API, Alex, and prior local edits are preserved. No GitHub push.

## Alex live inference through saved provider assignment

Alex now uses his saved Phase 2 agent-01 assignment through a server-only OpenRouter provider adapter. Startup attaches that adapter to the existing ModelRouter; before every Alex request it checks the exact assigned route, enabled connection, current revision, 24-hour verification and required text/system-instruction evidence. The existing runtime still builds Alex's original system instructions, memory, history, authored context and approved Sophia queue, then sends them through ConnectionManager.inferenceProbe with its encrypted credential, protected endpoint/IP/TLS policy and bounded response handling. No key reaches the browser, logs or Alex's prompt. Existing environment providers and manual selection remain available. Model replies retain provider/model attribution and full transcript continuity.

Automatic switching is limited to three consecutive responses taking at least 12 seconds, or observed OpenRouter key allowance at or below 10% of a positive key limit, or a provider 429 rate-limit response. The key allowance comes from OpenRouter's authenticated /key endpoint; deprecated request-count metadata is not used. A switch is considered only among saved ordered fallback route IDs. Before use, the adapter reassesses eligibility, refreshes a stale catalog when needed, and explicitly verifies required capabilities when evidence is missing/expired. It never selects a newer, cheaper or more capable model for that reason alone, and never switches on an unrelated model failure. The switch occurs before Alex builds the next system prompt, records a local event, and displays a notification in chat with the reason. On 429, the failed request is reported honestly; the next request may switch. If no fallback is eligible, Alex reports the problem instead of claiming online status. A generic provider failure also remains an error.

Real OpenRouter validation: the saved primary assignment is aion-labs/aion-2.0. A protected dashboard POST /api/alex chat request returned HTTP 200, status online, that exact model, and a genuine model-generated Alex reply identifying him as employee 01 and Personal Communicator. The assignment currently contains one candidate, so no real fallback switch was possible. The older conversation and identity files were preserved. Existing Sophia queue/delegation controls remain, but Sophia's adapter is still unavailable; no executable model tools were added.


## OpenRouter catalog eligibility and targeted verification

Inspection of the real OpenRouter registry confirmed an enabled revision-2 connection, accepted authentication, successful current discovery and 653 correctly scoped catalog routes. Exactly 650 had no verification; two recorded INVALID_RESPONSE and one (aion-labs/aion-3.0) passed text/streaming but received MODEL_UNAVAILABLE on the tools probe, before system instructions ran. The connection's inference health records the last probe, not availability of every model.

Root cause of the blanket unavailable message: AgentAssignments.assess checked route.access.state !== 'verified' before missing verification, so discovery-only listed/account-listed routes all returned MODEL_UNAVAILABLE. Fixed eligibility reasons to distinguish disabled connections, stale/failed catalogs, missing/current-revision verification, individual probe failures, expiry and capability mismatch. Every eligibility gate remains enforced. The UI now explains the actual reason and labels connection inference health as the last probe.

A second integration issue was that the UI always requested all five probes, regardless of the selected agent's requirements. An unrelated optional-capability failure could stop verification before required system instructions. The UI now explicitly verifies selected required capabilities (text is always tested); additional requirements can be selected to test more. No failed capabilities are promoted, no failed provider response is ignored, and new observations leave unrequested capabilities untested.

Real validation on 2026-10-30: aion-labs/aion-3.0 passed new text and system-instruction requests through the existing vault and protected transport; compatibility assessment returned OK for Alex's requirements. No assignment or Alex runtime selection was changed. The earlier failures remain in history; no other model was claimed verified. Raw credentials/responses were not logged. No Nexus or GitHub push.

Validation: 113 full tests passed, the focused 32-test verification suite passed after a fixture type correction, frontend/server typecheck and production build passed, and git diff --check passed. The real dashboard request returned HTTP 200 and status online through aion-labs/aion-2.0. The existing large Vite bundle warning remains. No real automatic switch was observed because no fallback is saved.

Validation: all 111 tests pass, frontend/server typecheck and production build pass, and git diff --check passes. Restarted the running backend to activate the eligibility change. A protected HTTP query of the live dashboard returned 653 routes with zero provider/connection/revision association mismatches: 649 UNVERIFIED, two INVALID_RESPONSE, one MODEL_UNAVAILABLE and one OK at the final check (live eligibility counts changed during the investigation). No bulk verification or assignment was performed. The existing large-bundle warning remains.


## Android browser — AI Providers fetch receiver fix

The Android “Failed to execute 'fetch' on 'Window': Illegal invocation” error was caused by AiClient storing native fetch and invoking it as this.#fetch(...). That method call supplied the AiClient instance as the receiver instead of Window, so browser receiver validation failed before the request reached /api/ai. The resulting API-unavailable UI was a client-side failure, not a backend startup, route, authentication or cache error. Inspection found Alex's existing fetch calls use direct global invocation and do not share this defect.

AiClient now binds both default and injected transports to globalThis. Existing request URLs, session cookies, CSRF headers, origin checks, timeouts, no-store behavior and credential handling are unchanged. Added a receiver-enforcing browser-compatible regression that reproduces the old TypeError before HTTP, then exercises default/injected clients, connection loading and a protected credential write against the actual local API in isolated fixtures. Earlier arrow-function mocks and Node fetch did not enforce Window receiver semantics, explaining why they passed. No Alex, design, Capacitor or backend security changes; no GitHub push.

Validation: all 109 tests pass; frontend/server typecheck and production build pass; git diff --check passes. The live dashboard on localhost:3000 serves the binding fix, loads connection metadata and accepts a CSRF-protected catalog query through the client with a browser-style receiver check. A missing-CSRF request still returns 403. Live checks made no provider mutations or external model calls. Direct Android browser interaction remains unavailable; the Window receiver requirement is reproduced by the regression fixture. The existing large-bundle warning remains (1,175.54 kB / 326.97 kB gzip).


## Dashboard visibility — development PWA cache fix

Investigation confirmed the running Vite process uses apps/dashboard and serves App.tsx with the AI Providers button/import/conditional page mount, plus desktop/mobile navigation CSS. The page has no permission, credential or feature-flag visibility gate. The defect is the production PWA worker's broad cache-first handling of scripts/styles: after switching the same origin to development it can cache unchanged /src URLs and keep serving old navigation. Development previously neither removed that worker nor served valid JavaScript at /service-worker.js (Vite returned the HTML fallback). A regression test reproduces stale navigation under that policy. The user's browser cache cannot be inspected here, so attribution of the reported screen to that reproduced defect remains an inference.

Fixed development HTML to remove only this dashboard's worker and shell caches before a one-time reload. Development now serves a no-store retirement worker, and production caching is restricted to its precache asset list so it cannot capture development modules. Existing production offline support, UI/navigation, Alex and all provider services are preserved. The running server has loaded the fix; reload http://localhost:3000 to receive it. No GitHub push.

Validation: all 108 tests pass, frontend/server typecheck passes, production build passes and git diff --check passes. Three new regressions cover stale development-module caching, scoped worker/cache removal without reload loops, and actual Vite navigation/component/CSS/worker responses. Parallel Vite test fixtures now allow available-port selection to avoid collisions. Production frontend asset hashes and the existing large-bundle warning are unchanged. Interactive browser/device confirmation remains unavailable.


## Phase 2 — AI Providers management dashboard

Added **AI Providers** to the existing desktop/mobile dashboard navigation using the current panel design. The interface manages multiple OpenRouter, OpenAI-compatible and Ollama connections: add, edit, explicit test, enable/disable, discover models, replace/clear write-only credentials and confirm removal. Searchable model pages filter by provider, connection and output modality, preserve exact routes, distinguish advertised capabilities from tested observations and show sanitized connection/catalog/verification failures, expired evidence and historical results. Agent controls save compatible primary candidates and ordered fallbacks with required capabilities and revision checks; Alex always requires observed text and system instructions.

The pre-coding integration audit found that Steps 2–4 supplied the required services through CLIs but had no dashboard HTTP surface. Added only a protected `/api/ai` adapter over the existing connection manager, provider registry, catalog, verification and assignment services. It reuses the existing API server, proxy, local host/origin boundary, HttpOnly session and CSRF validation. Storage initialization is lazy, so provider storage errors do not stop Alex/UI. Provider operations/errors do not write Alex's memory/audit. No parallel provider implementation, dependency, database or credential store was introduced. Existing local work and all prior CLIs/watcher functionality were retained.

Credential password inputs clear immediately on submission, including failures, and on provider change/cancellation/page exit. Keys never enter browser persistence, URLs or response contracts, and saved credentials cannot be revealed. Existing encryption, endpoint clearing, SSRF protection, IP pinning and TLS safeguards remain in the backend. Alex's identity/personality, memory implementation, live runtime model selection, chat, office and existing agent features are unchanged. No Nexus or GitHub push.

Validation: **105 tests pass** (98 existing plus seven dashboard transport/integration tests); frontend/server typecheck, production build and `git diff --check` pass. New tests exercise the browser client through real local HTTP and the Vite proxy, session/CSRF/input protections, credential encryption/redaction, revisions, catalog pagination, explicit verification, compatibility rejection, ordered fallbacks, safe failures and unchanged Alex memory. Production JavaScript is 1,175.51 kB / 326.96 kB gzip; Vite retains the existing large-bundle warning. No dependency was added.

Remaining integration limits: saved assignments are not consumed by live agent inference; the UI states that they do not change Alex's active model or activate automatic failover. That runtime bridge is outside this UI task. No real credentials/model service were supplied or externally verified; automated provider successes are isolated fixtures. Interactive browser/device visual QA is unavailable in this environment. There are no remaining implementation blockers for the management interface. See [AI Providers dashboard](docs/AI_PROVIDERS_DASHBOARD.md) for the audit, workflow and HTTP contract.

## Phase 2 — Step 4: explicit model access verification and compatible assignments

Implemented explicit backend verification through exact provider/account/model routes, using the encrypted vault and protected POST transport. Independent persistent observations distinguish verified, unavailable, untested and incompatible access, with UTC timestamps, connection revisions, exact IDs and tested capability states. Text, SSE/NDJSON streaming, function calling, simple structured output and system instructions use provider-specific validated probes; discovery alone never verifies access. Authentication, credit/quota, rate-limit, timeout, malformed response and provider failures remain sanitized and observable. Catalog refresh preserves history, while configuration changes and failures prevent stale eligibility.

Added persistent explicit multi-candidate agent assignments with capability checks, 24-hour evidence expiry, revision checks, rejection reasons and eligible fallback candidates. Alex (01) is the first profile and always requires observed text and system instructions. His existing runtime, identity/personality, memory, UI and environment-based model selection remain unchanged; assignments do not activate runtime inference or automatic fallback. Other agent IDs can use the same system. No Nexus, dashboard redesign or GitHub push.

Validation: all 98 tests pass (69 unchanged existing tests plus 29 verification/assignment tests), frontend/server typecheck and production build pass, and models CLI help passes. The frontend asset hashes are unchanged; Vite retains the existing 1,151.00 kB / 319.93 kB gzip bundle warning. Git comparison confirms Alex, frontend, API and startup implementations are unchanged.

Actual external inventory: **no real models verified**. No default provider registry, server credential files or relevant credential environment variables are configured, so no external calls were performed and no Alex assignment is activated. Test successes use mocked responses/local test servers only. See [Model verification](docs/MODEL_VERIFICATION.md) for setup, status semantics and limitations. Next: configure real provider accounts, discover exact routes, explicitly verify them and assign compatible Alex candidates before runtime activation.

## Phase 2 — Step 3: automatic model discovery and unified catalog

Implemented automatic discovery for enabled OpenRouter, OpenAI-compatible and Ollama registry connections, with source-specific/full pagination, exact model IDs, independent account/gateway routes and a persistent searchable catalog. Metadata/capabilities are normalized only from source evidence; missing fields stay unknown. OpenRouter requests all output modalities from its user-filtered listing. Listings remain listed/account-listed, never verified model access; no inference probe or model assignment is performed.

The independent catalog watcher starts with dev/production-preview and also supports standalone `npm run catalog -- watch`. It detects new/changed enabled connections, refreshes due catalogs, skips disabled ones and backs off failures. Cached search/get/status and explicit refresh/sync are provided through the backend CLI. A worker failure does not stop Alex/UI. The new private `catalog.sqlite` is separate from the unchanged encrypted connection store and Alex memory. Atomic staging retains last-complete results after failed/partial refreshes; revisions, leases and snapshot-bound search cursors prevent stale/mixed results. Historical unavailable routes remain queryable.

Existing endpoint validation, DNS/IP pinning, TLS checks and credential encryption are reused. Pagination cannot redirect to other hosts/paths, and credential echoes are rejected before storage. There is no arbitrary model-count ceiling; per-response/page resource limits fail explicitly rather than truncating. All Alex source/frontend/API and existing tests remain unchanged; the startup supervisor only adds an independent worker and bounded shutdown cleanup. No Nexus or dashboard redesign.

Validation: all 69 tests pass (44 unchanged existing tests plus 25 catalog/integration tests), as do frontend/server typecheck, production build and catalog CLI help. The production frontend asset hashes and existing large-bundle warning remain unchanged (1,151.00 kB minified / 319.93 kB gzip).

See [Model catalog documentation](docs/MODEL_CATALOG.md) for commands, supported pagination, access semantics and limitations. External account inventories/access were not tested because no real provider credentials/services were configured. Next: explicit compatible-model access verification and agent assignments, without autonomous Nexus selection.

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

`npm run typecheck` (frontend + backend/tests), `npm test` (98 deterministic tests: the 69 prior tests plus 29 verification/assignment tests) and `npm run build` pass. The production bundle retains Vite's existing large-chunk warning (1,151.00 kB minified / 319.93 kB gzip). Live dashboard/API smoke checks verify the unconfigured/offline path and private-memory access denial. No live provider inference, browser interaction or Android device performance evaluation was possible.

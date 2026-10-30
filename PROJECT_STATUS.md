# Project status

Updated: 2026-10-30

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

`npm run typecheck` (frontend + backend/tests), `npm test` (16 deterministic tests) and `npm run build` pass. The production bundle retains Vite's existing large-chunk warning (1,151.00 kB minified / 319.93 kB gzip). Live dashboard/API smoke checks verify the unconfigured/offline path and private-memory access denial. No live provider inference, browser interaction or Android device performance evaluation was possible.

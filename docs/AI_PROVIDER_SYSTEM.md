# AI Provider System — Phase 2, Step 1

## Baseline and inspected changes

Recovery commit: `8dd6f11` (`phase2-step1-baseline` tag). This local commit preserves the completed office and Alex implementation before any Step 1 source edits. Inspection found modified `.gitignore` and README files plus the untracked application and documentation; all 39 versionable files were reviewed and captured. A credential-pattern scan found no matches; ignore checks confirmed private Alex memory, `.env.server`, dependencies and generated build output were excluded. No existing work was reset or discarded, and no push was performed.

The pre-change suite passed all 16 Alex tests. Alex uses `ModelProvider`, `HttpProvider` and `ModelRouter` in `apps/dashboard/server/providers.ts`: one model per instance, an environment-created list, one selected provider, ID-only optional discovery and string-only inference. There is no shared provider registry/database/catalog. Backend security already includes localhost host/origin checks, sessions/CSRF, bounded requests, sanitized errors, private static-file denial and API cache exclusion.

## Added contract files

- `apps/dashboard/server/ai/contracts.ts`: schema version 1; provider, connection, model, route, searchable catalog, discovery-page/refresh, evidence, pricing/limits/usage, inference, explicit agent assignment and legacy compatibility interfaces.
- `apps/dashboard/server/ai/route-identity.ts`: pure route-key definition and input validation, shared with future persistence/search implementations.
- `apps/dashboard/tests/provider-contracts.test.ts`: route identity and existing-class compatibility checks, plus a compile-time guard against adding plaintext keys to public connection metadata.

No new modules are imported by the application, Alex bootstrap or frontend. Existing source files, dependencies, API handlers, scripts and configuration are unchanged. The contract file reuses existing `ModelMessage`, `ModelProvider` and `ModelRouter` through type-only imports. `HttpProvider` continues to satisfy `ModelProvider`; no transport is replaced or instantiated by production Step 1 code.

## Identities and boundaries

| Contract | Meaning |
| --- | --- |
| `ProviderDefinition` | Vendor/gateway definition and extensible adapter identifier. It owns neither a model selection nor account credentials. |
| `ProviderConnection` | One globally unique configured endpoint/account/project/region, enabled flag, revision, safe credential-presence metadata and independent auth/discovery/inference observations. |
| `ServerConnection` | Safe connection plus an opaque credential-store reference. Server-only; never return this object from a future public API. |
| `ModelDescriptor` | Exact native model ID, display name, capability evidence, limits and sanitized vendor-specific extensions. |
| `ModelRoute` | A model accessed through a specific connection and optional upstream endpoint, with protocol, configuration revision, access evidence and lifecycle. |
| `CatalogEntry` | Route plus commercial/limit observations and first/last-seen timestamps. |
| `ModelCatalog` | Search/get/refresh interface. Cursor pages describe a stable snapshot, not a fixed-size universe of models. |

A route key is `route:v1:` followed by JSON encoding of the tuple `[connectionId, nativeModelId, upstreamEndpointId]`. Connection IDs must be globally unique. `null` upstream means default/automatic gateway routing; a named upstream is a separate route. JSON encoding avoids slash/delimiter collisions. Case, whitespace around nonblank IDs, Unicode, tags and exact provider model IDs are preserved. Labels never determine identity. Credential/configuration revisions do not change route identity, but are carried separately to detect stale eligibility and configuration.

No model-count ceiling or ID-length limit is imposed by these identity contracts. Later API/database validation must impose appropriate resource protections without silently truncating discovery. Catalog querying may page results; discovery must exhaust provider pagination before marking a refresh complete. Partial/failed refreshes must preserve the last complete catalog and must not falsely mark absent models removed. This lifecycle is a documented implementation requirement, not a worker implemented in Step 1.

## Metadata truthfulness

Capabilities have explicit supported/unsupported/unknown states. Unknown modality lists and token limits are null. A listed model is not necessarily account-authorized or verified by inference. Connection auth, discovery and inference success are separate observations, not one misleading online flag.

Prices use decimal strings with explicit currency, dimensions, unit and denominator. Incomplete/unknown prices are distinct from zero prices. Free access separates verified zero pricing, conditional free tiers, credits, paid, local execution without an API fee and unknown, with independent eligibility/evidence. Local execution is not a promise of free hardware/electricity. Quotas identify their actual account/key/project/region/model scope; an unknown limit is not unlimited. Usage distinguishes reported cost from estimated cost and records actual serving model/upstream when available.

`Evidence.reference`, extensions, scope IDs and endpoints must be sanitized by future adapters. Types alone do not enforce redaction, timestamp validity, monetary validation or SSRF protection. Opaque credential references are not secrets, but remain server-only. No encryption or secret persistence is claimed by this step.

## Compatibility and future assignments

`LegacyProviderBinding` explicitly associates a new route reference with an existing `ModelProvider` and `ModelRouter`. It is an integration seam, not a migration or a runtime adapter. Existing legacy IDs remain unchanged and are not assumed to equal new connection IDs.

`ProviderAdapter` supports paginated metadata discovery, text inference using existing `ModelMessage`, and optional limit observation. New inference results may carry usage; unavailable usage remains null. The catalog may describe other modalities even though this initial inference contract remains text-only. A future adapter must report and validate what its runtime can execute rather than equating catalog capabilities with executable capabilities.

`AgentModelAssignment` records an explicit agent/route/revision and required capabilities. `AgentModelResolver` defines a resolution seam; no selector/resolver is instantiated. Future resolution must reject disabled connections and incompatible or unavailable routes, retain agent identity/personality outside transport, and avoid automatic fallback. Nexus, autonomous model selection and spending policy are not implemented.

## Scope and next step

Step 1 introduces no database, provider CRUD API, discovery worker, live account test, credential editing/encryption, model downloads, routing changes or dashboard redesign. Alex's private memory and selected provider are untouched. No paid or external model request is made by the new tests.

The next step is a separately reviewed persistent connection registry and secret-store implementation, followed by provider-specific discovery adapters. The proposed SQLite store is separate from Alex's JSON memory; connection/master-key security, API authorization and private database/WAL file access must be validated before activation. Environment-based Alex configuration remains supported.

## Verification

Run from `apps/dashboard/`: `npm test`, `npm run typecheck` and `npm run build`. The unchanged Alex suite establishes regression coverage; new tests verify duplicate gateway/account routes, native-ID preservation, upstream distinctions, invalid identities, more than 1,000 entries, long IDs, compatibility with the existing classes, and safe/server-only credential-reference type separation. Tests do not prove a live AI connection or implement a functioning catalog.

Completed checks: all 23 tests pass (16 existing Alex tests + 7 new contract tests); frontend/server typecheck and production build pass. The existing Vite bundle-size warning remains (1,151.00 kB minified / 319.93 kB gzip). Existing Alex/application source, tests and configuration match the baseline. No live provider was contacted.

Inspect the recovery snapshot with `git show phase2-step1-baseline:apps/dashboard/server/providers.ts`. Once the working tree is clean, `git switch -c recovery/phase2-baseline phase2-step1-baseline` opens an independent branch at the baseline without deleting the Phase 2 commit. Do not use reset/clean to recover this work.

## Phase 2 Step 2 — implemented connection management

The contract-only Step 1 description above is retained as historical scope. Step 2 adds a separate backend `ConnectionManager`, SQLite connection/audit storage, an AES-256-GCM credential vault, revision-checked CRUD, provider-specific connection tests and a local CLI (`npm run providers -- help`). Supported connection types are OpenRouter, OpenAI-compatible and Ollama; multiple accounts/endpoints per type remain distinct.

No new provider-management HTTP/browser interface is exposed, so plaintext API keys never enter the frontend. Input credentials travel only through private redirected stdin to the local backend. The existing Alex provider/router/runtime/memory, frontend, API, startup scripts and tests are untouched. Only a new package script invokes the independent CLI; no automatic configuration migration or route activation occurs.

See [Provider Connection Management](PROVIDER_CONNECTIONS.md) for commands, safe input formats, storage/encryption recovery, SSRF policy, local-port approvals and limits. Model catalog refresh/persistence, commercial metadata ingestion, actual agent assignments and Nexus are not implemented by this step.

## Phase 2 Step 3 — implemented automatic discovery and catalog

Step 3 adds source-specific paginated discovery, a separate persistent/searchable SQLite catalog, atomic complete-refresh publication, provider failure status, per-connection refresh leases and automatic scheduling. Each enabled account/gateway connection retains separate exact native-model routes. Discovery never marks model access verified. Catalog searches include unavailable historical routes rather than silently losing alternatives.

The dev/preview supervisor now starts an independent catalog watcher. It can also run through `npm run catalog -- watch`; explicit refresh/sync and cached search/get/status commands are available. Catalog-worker failure does not shut down Alex/UI. Alex's identity, runtime, provider selection, private memory, frontend and API remain unchanged. No Nexus or dashboard redesign is introduced. See [Automatic Model Discovery and Unified Catalog](MODEL_CATALOG.md) for supported pagination, metadata, access semantics, scheduling, resource bounds and validation.

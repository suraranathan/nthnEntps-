# Automatic model discovery and unified catalog — Phase 2, Step 3

The backend discovers model listings for every **enabled** connection in the Step 2 registry. It stores exact provider routes in a searchable SQLite catalog. No discovery request performs inference, proves model access, modifies an agent assignment or changes Alex's provider/personality/memory. Source listings are evidence of listing only.

## Automatic operation and commands

Normal `npm run dev` and `npm run start` now launch a separate catalog watcher alongside the existing API/UI processes. It scans at startup and polls every five seconds for newly enabled/edited connections or refreshes due. A fatal catalog-worker error is reported without shutting down Alex/the UI; retry it with the standalone command below. Shutdown terminates the worker with the other children, with a bounded forced-cleanup fallback. An interrupted refresh is recovered after its lease expires.

From `apps/dashboard/`:

```sh
npm run catalog -- help
npm run catalog -- watch
npm run catalog -- sync
npm run catalog -- refresh
npm run catalog -- refresh CONNECTION_ID
npm run catalog -- status
npm run catalog -- search '{"search":"llama","pageSize":50}'
npm run catalog -- search '{"providerIds":["openrouter"],"outputModality":"image"}'
npm run catalog -- search '{"connectionIds":["CONNECTION_ID"]}'
```

`sync` performs one automatic scheduling pass; `refresh` explicitly refreshes all enabled connections, or one specified connection. `search` and `get ROUTE_ID` read cached results and do not contact providers. Use `npm run --silent catalog -- ...` for machine-readable stdout. Search can filter by exact connection/provider IDs, output modality or the contract's free-access classification. Pricing classifications currently remain unknown; source prices are preserved as metadata, not verified free access.

To continue a page, repeat the same filters/page size with the returned `nextCursor` in the `cursor` field. Catalog/state or connection configuration changes invalidate old cursors with `CATALOG_CHANGED`; restart pagination rather than mixing snapshots. Literal search matches native IDs/display names, including percent and underscore characters. Search page sizes range from 1 to 1000; this is a per-response resource bound, **not a total-model limit**.

Normal refresh interval is five minutes. Server environment `AI_CATALOG_REFRESH_MS` can set another interval of at least 60000 milliseconds. Failures have persisted exponential retry backoff starting at one minute, capped at one hour. Changed configurations retry without waiting for a prior configuration's backoff. Three bounded workers isolate unavailable providers during each scheduling pass. Disabled connections are not contacted; legacy Alex environment configuration is not silently imported into the registry or changed. Existing `AI_PROVIDER_DATA_DIR` and `AI_PROVIDER_LOCAL_PORTS` policies also apply to the catalog worker.

The watcher runs only while its process is running. It does not survive stopping Termux/rebooting without operator-managed startup. Failed connections return their own sanitized result; they do not erase other providers' catalogs or stop the overall scan. CLI explicit refresh/sync exits nonzero if any attempted provider fails. Watch progress logs include only connection IDs, states, counts and stable codes, not provider bodies, keys or cursor payloads.

## Source-specific discovery and complete pagination

| Connection | Listing and enumeration |
| --- | --- |
| OpenRouter | Authenticated `/models/user`, explicitly requesting `output_modalities=all`. Offset/limit pages of 500 are followed until exhaustion, including the final empty page when needed. No public-catalog fallback is silently substituted for account filtering. |
| OpenAI-compatible | `/models`, initially without assumed vendor-specific pagination parameters. Follows advertised cursors/tokens, `has_more`/`last_id`, next-page/next-offset fields, total/current-page metadata, same-endpoint next links and HTTP Link `rel=next`. |
| Ollama | `/api/tags`, keeping exact tags/quantized identities and supplied details. Its normal unpaginated model array is consumed in full; advertised generic pagination is also honored. |

Provider pagination markers, rather than a configured model-count limit, govern enumeration. Repeated cursors, pages with no new route progress, inconsistent totals/end markers and malformed continuations fail explicitly. Cursor pages and offset pages are not interchangeable assumptions; arbitrary custom pagination schemes need an adapter extension rather than being fabricated. Provider-side changing inventories cannot be turned into a point-in-time server snapshot unless the provider itself offers that guarantee.

References checked for implementation: [OpenRouter account-filtered models, modalities and pagination](https://openrouter.ai/docs/api/api-reference/models/list-models-filtered-by-user-provider-preferences-privacy-settings-and-guardrails), [OpenRouter model metadata](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties), [Ollama local tags](https://docs.ollama.com/api/tags).

## Routes, metadata and access truthfulness

Routes use the unchanged Step 1 identity tuple: connection UUID + exact native model ID + optional upstream endpoint ID. This implementation records the listing's default route (`upstreamEndpointId: null`) independently for each connection. Same-named models, case variants, free/paid suffixes, local tags and different accounts/gateways remain distinct. It does not infer that two display names are the same model or enumerate unadvertised gateway upstream endpoints. Explicit upstream pinning remains future adapter work.

Stored capabilities include source-provided input/output modalities, tools, streaming, structured output and system instruction support. Missing information remains unknown. Context/output token limits, ownership/creation, architecture, source parameter lists, digest/size, quantization/family, lifecycle hints and selected commercial fields are retained when present. Unsupported arbitrary/raw response fields are not persisted. Metadata is untrusted provider data, not an instruction, a verified capability test or a source of agent personality.

- OpenRouter user-filtered listings receive `account-listed`; generic/local listings receive `listed`.
- No route receives `verified` from discovery, even if authentication was previously accepted or the source advertises availability.
- Disabled, removed, reconfigured or currently failed connections expose cached routes as unavailable. This indicates unavailable current catalog evidence, not proof that every model's inference endpoint is down.
- Successful complete enumeration may mark previously listed-but-now-absent routes removed from the listing. These records stay queryable as unavailable historical routes, preserving alternative access paths and first-seen history. Rediscovery reactivates the route without inventing a new first-seen timestamp.
- Paid/free eligibility, usage and quota calculations are not inferred. Source pricing is retained in sanitized extensions while normalized pricing/free-access fields remain unknown. There are no bulk inference probes or automatic spending/model switching.

Future model-access verification must be separate, explicit and provider-appropriate; discovery/connection success cannot substitute for it. Model assignment and Nexus remain out of scope.

## Persistence, refresh consistency and security

A separate private `.local/ai/catalog.sqlite` stores routes, staging, refresh history, leases and a snapshot generation counter. It uses its own schema version 1; the existing encrypted connection database stays at schema version 1, with no credential migration. Permissions/ownership/path/symlink checks use the existing manager's private storage boundary. The catalog stores metadata only, never decrypted credentials. Existing Git ignore and Vite private-file denial cover the database and its journals.

Each connection refresh stages pages in a transaction-protected workspace. Only complete success publishes changes atomically. Partial/failed refreshes clear staging and retain the last complete catalog, while exposing sanitized errors and stale/unavailable status. A concurrent configuration revision change invalidates the refresh. Cross-process per-connection leases prevent competing publishers; expired leases recover interrupted staging. Leases renew per page. Search pages read a consistent catalog transaction and carry a snapshot tied to catalog generation, connection revisions/enabled flags and filters.

Model requests use the existing endpoint policy, all-answer DNS checks, pinned-IP transport, original-host TLS verification, approved loopback ports and no redirects. Pagination links can only refer to the same configured origin and exact listing path, with allowlisted query parameters; links cannot select arbitrary hosts, paths or credential query fields. Every page rechecks configuration and DNS. Known credential echoes anywhere in the response body or Link header are rejected before catalog persistence. No plaintext secret getter is added.

Management connection tests retain the existing 1MB response bound. Discovery uses a separate 16MiB per-page bound to accommodate larger catalogs; exceeding it fails explicitly, never silently drops records. There is no total catalog/model-count ceiling. An exceptional unpaginated source exceeding the response resource bound needs an appropriate streaming/paginated adapter extension. Both paths retain DNS/request deadlines and stable redacted errors.

## Files and validation

- `discovery.ts`: metadata normalization, source queries and pagination parsing.
- `catalog-store.ts`: private SQLite catalog, atomic staging/publishing, refresh leases and searchable snapshot pages.
- `catalog-service.ts`: protected enumeration, access-state handling and automatic scheduling/backoff.
- `catalog-cli.ts`: watch/sync/refresh/search/get/status commands.
- Existing connection manager/transport/adapters: narrow protected listing-request and metadata extensions; existing management operations remain supported.
- Startup runner: independent catalog worker; catalog errors do not take down Alex/UI.

The catalog suite covers multi-page discovery beyond 1000 models, multiple accounts/routes, exact IDs, metadata/unknowns, literal search and stale cursors, partial failures, removal/rediscovery, unsafe pagination, credential echoes, persistence/permissions, cross-process leases, scheduling, real local HTTP, responses above 1MB, CLI reads, a live watcher subprocess and combined-runner failure isolation. All earlier Alex, contract and connection-management tests remain unchanged. Live external provider access requires real accounts/credentials; fixture listings are never reported as actual connected models.

Validation completed: 69 tests pass (44 existing + 25 catalog/integration tests), frontend/server typecheck and production build pass, and the catalog help command exits successfully. The existing Vite bundle warning remains, with unchanged frontend asset hashes. No real external inventory or model access was claimed from test fixtures.

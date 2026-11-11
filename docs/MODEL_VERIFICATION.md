# Explicit model verification and compatible assignments — Phase 2 Step 4

Verification is an explicit backend operation, separate from automatic catalog discovery. No probe runs at startup, on catalog refresh, or during assignment resolution. It can consume provider credits. There is no Nexus, autonomous spending/retry policy, model download, new dashboard, public administration API or change to Jef's environment-based provider selection.

The later [AI Providers dashboard](AI_PROVIDERS_DASHBOARD.md) adds local controls for these same verification and assignment services. It keeps the explicit probe, compatibility, evidence-expiry and runtime limits described here; saved assignments still do not activate live agent inference.

## Commands

From `apps/dashboard/`, use the existing `providers` CLI to configure independent enabled accounts with private stdin credentials, then `catalog -- refresh` and `catalog -- search` to obtain exact route IDs. Pass a route ID as one quoted argument; it includes JSON punctuation. Never put API keys in arguments.

```sh
npm run models -- help
npm run models -- verify 'EXACT_ROUTE_ID'
npm run models -- verify 'EXACT_ROUTE_ID' text,systemInstructions
npm run models -- history 'EXACT_ROUTE_ID'
npm run models -- assign 0 '{"agentId":"01","candidateRouteIds":["EXACT_ROUTE_ID","SECOND_ROUTE_ID"]}'
npm run models -- assignment 01
npm run models -- resolve 01
```

The examples use placeholders, not verified model IDs. Verification always tests text first; optional capability names are `streaming`, `tools`, `structuredOutput`, and `systemInstructions`. Omitting the list tests all five capabilities, at most one bounded request each. Partial runs create new observations with omitted capabilities untested; they do not inherit old supported claims. `verify` exits nonzero if overall access is not verified. A verified text route can still have untested/unsupported optional capabilities, so inspect the capability map or assignment assessment.

`AI_PROVIDER_DATA_DIR` and `AI_PROVIDER_LOCAL_PORTS` have the same semantics as the existing CLIs. Public inference requires configured credentials; explicitly configured loopback services may operate without a key. Disabled, removed, stale-revision and unsupported upstream/protocol routes are rejected before inference. Only default upstream routes currently discovered by Step 3 are supported; named upstreams must gain a pinned adapter before verification.

## Observations and failure semantics

`catalog.sqlite` now also contains append-only verification history and separate agent assignments. No credential-store schema or memory migration is needed. Each verification includes a generated observation ID, UTC attempt/completion timestamp, exact requested native model ID, provider ID, connection/account/project/region, connection revision, status, stable error code, and per-capability state/timestamp/code. Account scope is operator metadata; the actual authentication route is the selected endpoint and its encrypted credential, not an inferred shared vendor account. Raw model text, tool arguments, error messages, headers, API keys and ciphertext are never persisted in results.

| Access result | Meaning |
| --- | --- |
| `verified` | A real text response passed the explicit probe through this connection revision; optional capability failures remain separate. |
| `untested` | No usable public credential was configured. Missing observation/history likewise means untested, regardless of catalog listing. |
| `unavailable` | Disabled/removed/stale route, auth rejection, quota/credit exhaustion, rate limit, network/timeout or provider failure. Historical successes remain historical. |
| `incompatible` | Baseline text request was rejected as incompatible/unsupported, or response failed the probe's format/content validation. This is conservative, not proof the model cannot work with another API. |

HTTP 401/403 map to `AUTH_REJECTED`; 402 and 429 with recognized insufficient-quota/credit codes map to `INSUFFICIENT_CREDITS`; other 429 responses map to `RATE_LIMITED`. 404 maps to `MODEL_UNAVAILABLE`; 400/422 are ambiguous `INCOMPATIBLE` request responses; 405/501 mean the tested endpoint/capability is unsupported. Other failures use stable sanitized codes. There are no automatic chargeable retries. An account/network failure during optional probes stops the run and marks access unavailable, retaining successful text evidence without claiming current availability.

Capabilities are independent `supported`, `unsupported` or `untested` observations. Only a validated response sets supported. Explicit 405/501 rejection sets unsupported for that tested wire capability; generic 400/422, malformed output, missing credentials and skipped probes stay untested. Catalog capability declarations remain source metadata and never qualify an assignment. Other modalities (vision, audio, video, embeddings), context limits, combined streaming-with-tools behavior, pricing and quotas are not verified by these text probes.

Catalog get/search expose the latest observation separately as `verification`, including its original revision and timestamp, and decorate current available routes with verified/unavailable access. Refresh does not erase history. Connection edits/credential rotation, disable/removal or catalog failure prevent old evidence from qualifying a route. Verification changes invalidate catalog paging cursors. A later failure supersedes a success for eligibility. The catalog's verified label is a timestamped observation, not a continuous health guarantee.

## Provider behavior and probe limits

OpenRouter and generic OpenAI-compatible endpoints use POST `/chat/completions`, SSE streaming, JSON-schema `response_format`, and function calls with JSON-string arguments. OpenRouter requests `provider.require_parameters: true`; default gateway routing remains default routing, not proof of every upstream's behavior. Generic endpoints are tested against this wire contract without assuming universal compatibility.

OpenAI and xKiro use the Chat Completions protocol with their own fixed endpoints; OpenAI probes use `max_completion_tokens`. Anthropic uses native `/messages` with `system`, tool and structured-output fields. Google Gemini uses native `generateContent`/`streamGenerateContent` with `systemInstruction`, generation configuration and function declarations. Their response formats are validated separately. Advertised model capabilities remain distinct from live probe observations, and paid inference probes require an explicit user action.

Ollama uses POST `/api/chat`, native `options.num_predict`, NDJSON streams, schema in `format`, native object tool arguments and a terminal `done` response. Ollama is prompted to call a tool without assuming support for OpenAI's forced `tool_choice`.

Text, system instructions and streaming use a fresh random expected response. The system probe places the expected value only in its system message. Structured output must match a simple schema exactly, and tool output must name the requested harmless function with matching arguments. Returned tools are never executed. Streaming must contain actual content framing and a terminal marker; JSON responses masquerading as streams, incomplete streams and embedded errors fail validation. The transport buffers a bounded stream for validation; this does not measure latency or prove arbitrary prompts/schema/tool combinations. Results describe successful sample behavior, not certification of full provider API semantics or subjective Jef personality quality. Providers can normalize/alias the requested model internally; exact route verification cannot attest underlying model weights.

The protected manager reuses the vault, per-request endpoint validation, DNS/IP pinning, hostname TLS verification, redirect rejection, 15-second deadline and a 256,000-byte inference response limit. Non-success response bodies are read only within that bound to recognize stable quota codes; raw errors never escape the service. In-flight configuration changes invalidate responses. Concurrent verification of the same route is rejected within one service instance; independent CLI processes can run explicit probes concurrently, with latest completed history controlling eligibility.

Wire references: [OpenRouter chat API](https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request), [OpenRouter provider parameter routing](https://openrouter.ai/docs/guides/routing/provider-selection#requiring-providers-to-support-all-parameters), and [official Ollama chat API](https://docs.ollama.com/api/chat). These document request formats; they are not evidence of configured model access.

## Assignment semantics

`AgentAssignments` persists an ordered list of explicit candidate route IDs per agent, required capabilities and an optimistic revision. Revision 0 creates; updates must use the current revision. All candidates must be currently compatible at assignment time. `resolve` reassesses every candidate, returns reasons for rejection, the first eligible route, and eligible fallback candidates. It performs no inference or automatic retry/failover. Callers must reassess before use; a result is not a lease on future availability.

Compatibility requires an enabled current-revision available route, latest verified text access, every required capability observed supported, and evidence no older than 24 hours. Catalog metadata alone, unknown/untested/unsupported capabilities, failed latest observations and expired evidence cannot qualify. `assess` accepts an explicit alternate maximum age for backend callers; assignment/resolve use the default.

Jef's existing ID `01` is the first profile. It always requires text and system instructions, even if an operator supplies fewer requirements. His identity/personality/instructions, memory, UI and existing runtime are unchanged. Other agents can use the same service with their IDs and capability requirements without modifying their implementations. This step prepares assignments and compatible alternatives; it does not activate a new Jef runtime transport, install execution tools, or implement Nexus.

## Actual verification inventory

As of 2026-10-30, **no external model is verified and no Jef assignment is activated**. Inspection found no default provider registry, `.env.server`, `.env`, or relevant provider credential environment variables. Consequently there are no configured real account/model routes to probe, and no external API calls were made. Configure each provider account's credentials (or an approved loopback service), discover its exact routes, run explicit verification, then create the assignment. All provider response successes in automated tests are fixtures or local test HTTP servers, not live provider evidence.

Automated validation covers route/account separation, native IDs, truthful discovery, capability wire formats, persisted/reopened history, credential redaction, auth/credits/rate limits/provider failures, malformed and incomplete output, disabled/stale/removed accounts, concurrency, assignment revisions and fallbacks, expiration and catalog cursor invalidation. Existing management, catalog, Jef and contract regression suites remain in place.

Completed validation: all 98 tests (69 existing plus 29 new) pass, frontend/server typecheck and production build pass, and `npm run models -- help` succeeds. The frontend asset hashes and existing Vite bundle-size warning remain unchanged. No external model verification was performed.

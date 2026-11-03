# Provider connection management — Phase 2, Step 2

Step 2 adds persistent backend connection management, operated through a local CLI. It does not change Alex's provider selection, identity, memory, API or chat. It adds no browser credential form, HTTP administration endpoint, dashboard redesign or Nexus implementation.

The later [AI Providers dashboard](AI_PROVIDERS_DASHBOARD.md) now exposes these same services through the protected local `/api/ai` transport and write-only credential forms. The Step 2 CLI instructions below remain valid; its historical lack of an HTTP interface is no longer a current integration gap.

## Run

Requires the existing Node 24+ runtime, with built-in SQLite; no new package is needed. From `apps/dashboard/`:

```sh
npm run providers -- help
npm run providers -- providers
npm run providers -- list
npm run providers -- audit
```

Use `npm run --silent providers -- ...` when parsing stdout as JSON. The default store is `.local/ai/providers.sqlite`; the first storage operation creates a random 256-bit backend master key in `.local/ai/master.key`. Directory/file permissions are 0700/0600 and ownership is checked. The existing Git ignore and Vite private-file denial cover this directory. No provider connects automatically, and new connections default to disabled.

`AI_PROVIDER_DATA_DIR` optionally selects another private directory. Within this checkout, only `apps/dashboard/.local/` and its descendants are accepted; external directories must be private, owned by the current user and outside symlinked paths. Frontend source/public/build folders and arbitrary project directories are rejected. This implementation targets the existing POSIX/Termux environment.

## Add a connection

Use a private file or trusted secret-manager pipe for stdin; never put a real key in arguments, shell history, source, browser code or logs. Interactive terminal stdin is rejected. The following JSON describes the input format; replace the placeholder in a private editor, not an `echo` command containing a real key:

```json
{
  "connection": {
    "providerId": "openrouter",
    "label": "Personal account",
    "baseUrl": "https://openrouter.ai/api/v1"
  },
  "apiKey": "REPLACE_IN_PRIVATE_INPUT_FILE"
}
```

Store request files under the private `.local/` tree or outside the checkout, with mode 0600. Then:

```sh
npm run providers -- add < .local/private-request.json
```

The JSON output contains safe metadata, connection UUID, revision and credential presence only. Keys are never returned. Delete the plaintext input privately when no longer needed. Do not send secret input to `tee` or retain it in terminal recording/debug logs.

Multiple connections may use the same provider and label. IDs remain unique; model routes will later use connection identity, not labels. Supported IDs:

| Provider ID | Base URL / connection test |
| --- | --- |
| `openrouter` | Exact `https://openrouter.ai/api/v1`; authenticated `GET /key` checks key acceptance. |
| `openai` | Exact `https://api.openai.com/v1`; authenticated `GET /models`. |
| `anthropic` | Exact `https://api.anthropic.com/v1`; authenticated `GET /models`, native Messages inference. |
| `gemini` | Exact `https://generativelanguage.googleapis.com/v1beta`; authenticated `GET /models`, native GenerateContent inference. |
| `xkiro` | Exact `https://api.xkiro.com/v1`; public `GET /models` checks reachability, not key access. |
| `openai-compatible` | A public HTTPS or approved loopback API base, commonly ending `/v1`; `GET /models` validates the returned listing shape. Supports bearer or `x-api-key` auth via `authStyle`; credential presence does not prove authentication. |
| `ollama` | Root origin, commonly `http://127.0.0.1:11434`; `GET /api/tags` validates local listing shape. |

The OpenRouter probe uses the documented [key endpoint](https://openrouter.ai/docs/api_reference/limits); Ollama uses the documented [tags endpoint](https://docs.ollama.com/api/tags). Only minimal health observations are retained, not arbitrary account response fields or provider error bodies. These tests do not run inference, download models, persist a catalog or claim that all listed models can be invoked.

For a local connection, explicitly select `"networkPolicy": "loopback"` and omit `apiKey` if not required:

```json
{
  "connection": {
    "providerId": "ollama",
    "label": "Local Ollama",
    "baseUrl": "http://127.0.0.1:11434",
    "networkPolicy": "loopback"
  }
}
```

Default loopback ports are 11434, 1234, 8000 and 8080. To approve another local model-server port, set server-side `AI_PROVIDER_LOCAL_PORTS=9000` (comma-separated for several). Ports 22, 3000 and 3001 remain prohibited. This is an explicit operator-approved exception for model servers, not permission to access arbitrary internal networks. LAN/private-address providers are not supported in this initial security policy. Public destinations require HTTPS on port 443; self-signed certificates are not accepted.

## Edit, test, enable, disable and remove

Copy the current UUID and `revision` from `list` or `get`. Every mutation/test must provide the expected configuration revision; stale requests return `CONFLICT` without overwriting newer settings.

```sh
npm run providers -- get ID
npm run providers -- edit ID REVISION < .local/private-metadata.json
npm run providers -- credential ID REVISION < .local/private-credential.json
npm run providers -- test ID REVISION
npm run providers -- enable ID REVISION
npm run providers -- disable ID REVISION
npm run providers -- remove ID REVISION
```

- Edit input permits `label`, `baseUrl`, `networkPolicy`, `enabled`, and `scope` only. Scope, if present, contains all three `account`, `project`, `region` string-or-null fields. Scope is metadata, not an implemented native provider authentication/header scheme. Provider type is immutable; create a new connection to change it.
- Credential input is `{"apiKey":"NEW_VALUE_IN_PRIVATE_FILE"}` or `{"apiKey":null}` to clear. A credential change increments both configuration/credential revisions and resets health. Metadata-only changes preserve credentials.
- Endpoint/network-policy changes automatically clear credentials and health, preventing an old key from being forwarded to a new host/path. Set the intended replacement credential explicitly afterward.
- Enabled is an operator eligibility flag, not proof of connectivity. It does not alter Alex's existing route or launch automatic activity. An explicit `test` is allowed while disabled; other operations never make provider requests.
- Test persists independent authentication/discovery observations, sanitized failure codes and check time; inference remains `never-tested`. An OpenAI-compatible models listing can succeed while authentication remains `unknown`. OpenRouter's key test marks authentication accepted, not model inference available.
- Health updates do not change configuration revisions. If configuration changes during a network test, its stale result is rejected rather than applied to the new configuration. Concurrent tests in one manager are rejected; separate processes still use revision-checked transactions.
- Remove deletes the connection and encrypted credential atomically, preserving a sanitized audit event. There are no assignments to cascade yet.

CLI failures return exit code 1 and stable sanitized JSON errors on stderr. A failed connection test returns its safe result on stdout with exit code 1. `audit` shows the latest 100 records; the database retains prior records. No raw provider exception/body or credential is logged.

## Encryption and recovery

Credentials are encrypted with AES-256-GCM, fresh 96-bit nonces and authenticated data bound to connection ID and credential revision. The backend master key is separate from the SQLite database. An authenticated verifier detects an incorrect replacement key, including when there are no connections. Missing keys are never silently regenerated for an existing database. Credentials, ciphertext and audit changes commit together in SQLite transactions; no new dependencies or Alex memory migrations are introduced.

Back up the database and master key privately, with access controls; keep the key separate from shared/exported database backups. Do not delete or replace the key as a way to reset credentials: restore its private backup instead. Credential replacement/clearing is supported; master-key rotation is not implemented yet. Encrypted credentials are not an OS keychain or protection against compromise of the same user account, which can read both files. Non-secret connection metadata is plaintext.

The manager refuses unsafe key/database permissions, symlinked files/ancestors, unsupported schema versions and data placement in frontend paths. It exposes no public plaintext credential getter; private fields also prevent accidental serialization of the vault or database. Plaintext credentials exist transiently in the backend process when encrypting or explicitly testing a connection.

## SSRF boundary

Endpoints reject userinfo, queries, fragments, percent/backslash/control-character tricks and unsupported path/scheme/port combinations. OpenRouter's official origin/path is pinned by its adapter. Public DNS answers must all be globally routable; private, loopback, link-local, metadata, multicast/reserved and IPv6 mapped/transition destinations are rejected. The IP policy is deliberately conservative and can reject some unusual legitimate ranges.

DNS is revalidated before every explicit test; the transport connects directly to the approved IP rather than resolving the hostname a second time. HTTPS validates the original hostname/certificate with verification explicitly enabled. Loopback requires literal `localhost`, `127.0.0.1` or `::1`, an approved port and only loopback DNS answers. Redirects are never followed, proxy environment routing is not used by this transport, headers/body sizes are bounded and requests have deadlines. DNS has a five-second deadline and HTTP/body processing a fifteen-second deadline. A probe larger than 1MB fails explicitly; this is a connection-test bound, not a truncated catalog.

## Implementation and verification

- `connection-manager.ts`: SQLite persistence, revision checks, safe metadata, credential lifecycle, CRUD, tests and audit.
- `credential-vault.ts`: authenticated encryption and private key-file handling.
- `connection-adapters.ts`: extensible provider definitions, endpoint-specific constraints, credential policy, test path and result interpretation.
- `endpoint-policy.ts`: shared address/endpoint policy, DNS pinning and bounded transport.
- `management-types.ts`: management input/output types and stable sanitized errors.
- `provider-cli.ts`: backend-only user interface, private stdin and safe JSON output.

Tests cover persistence, multiple accounts, credential encryption/redaction/tampering/rotation, missing/wrong keys, permissions/symlinks, optimistic concurrency, endpoint-change key clearing, database rollback, endpoint validation, DNS/metadata/rebinding attacks, provider-specific health, actual local HTTP requests, redirects/body bounds and CLI workflows. All prior Alex and contract tests remain unchanged. Live external account validation requires real credentials and was not performed. Provider catalog discovery, agent assignment and Nexus remain future work.

Verification completed: 44 tests pass (16 Alex + 7 contracts + 21 management), typecheck and production build pass, and the CLI help command exits successfully. The frontend asset hashes are unchanged; Vite retains its existing bundle-size warning. Real external credentials were unavailable, so external account success and live inference were not tested.

## Step 3 integration

Enabled connections are now consumed by the independent automatic catalog watcher started by dev/preview, or by `npm run catalog -- watch`. Connection management commands and credential policy remain unchanged. Edits invalidate old catalog evidence immediately, disabled/removed connections become unavailable in cached results, and changed revisions invalidate in-flight discovery. A new protected manager operation permits only provider-owned listing paths and allowlisted pagination parameters; it does not expose plaintext credentials. Existing connection tests remain inference-free and retain their 1MB response limit. See [Model catalog](MODEL_CATALOG.md) for the separate 16MiB discovery-page limit, atomic catalog refreshes and commands.

## Step 4 integration

`npm run models -- verify ROUTE_ID` explicitly tests inference through the selected enabled connection and encrypted credential. Provider/account routes remain separate; no plaintext credential getter or browser endpoint was added. Protected POST requests reuse endpoint/DNS/TLS policy and add a 256,000-byte bound. Authentication, quota/credits, rate limits, provider failures and malformed output produce sanitized independent verification records. Existing `providers test` remains inference-free. Assignments use verified current-revision capability evidence, not connection-test or discovery success. See [Model verification](MODEL_VERIFICATION.md). No real external accounts were configured or verified.

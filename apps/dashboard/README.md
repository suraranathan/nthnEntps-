# Dashboard and Alex

The existing React + Vite + TypeScript / React Three Fiber office includes Alex (01), a model-backed Personal Communicator runtime, and six placeholder colleagues. No provider/model is configured by default. Selecting Alex’s existing avatar/profile or **Talk to Alex** opens chat; other office/camera/dashboard controls remain available.

## Run on Android / Termux

Use Node 24 or later. From this directory:

```sh
npm install
npm run dev
```

This runs the agent API on loopback port 3001 and Vite on port 3000. Open **http://localhost:3000** on the same device. Keep Termux running for chat and scheduled updates. Both ports must be free. To run the production build:

```sh
npm run build
npm run start
```

The combined runner stops its processes on Ctrl+C or if either fails. For separate development terminals, use `npm run dev:agent` and `npm run dev:ui`. The agent server does not hot-reload server source or `.env.server`; restart it after changes. Frontend hot reload remains available.

## Connect a real model

1. Copy `.env.example` to `.env.server` in this directory. The server file is ignored by Git. Restrict its permissions to your user (`chmod 600 .env.server`).
2. Configure an accessible text-chat model, either:
   - OpenAI-compatible: `ALEX_BASE_URL` (including `/v1` where required), `ALEX_MODEL`, and `ALEX_API_KEY` (or server process `OPENAI_API_KEY`). The gateway must support Chat Completions with `max_completion_tokens`.
   - Existing local Ollama: `ALEX_OLLAMA_URL` (default `http://127.0.0.1:11434`) and `ALEX_OLLAMA_MODEL`. Run Ollama separately and install a model yourself. This app never downloads a model silently.
3. Restart `npm run dev` or `npm run start`.
4. Open **Talk to Alex → Settings → Test real connection**. This makes a real model request, may incur provider charges, and stores its generated response. Successful inference is required for online status. When both adapters are configured, select one in Settings; memory is preserved.

Never use `VITE_` variables for secrets or paste keys into chat. Provider URLs/keys/models are configured on the server, not accepted from browser payloads. The model receives conversation context, explicit notes/preferences, authored office/team facts and the project status document. There is no canned chatbot fallback: with no working provider, Alex reports offline/error.

## Memory, updates and permissions

Use **Memory** to save/remove project context, relationships, real shared jokes or temporary task notes. Use **Settings** to save humor/communication preferences, quiet hours/timezone, notification interval and daily briefing time. All live on the local server in `.local/alex/alex.json`, separate from identity and the full transcript, and survive restarts/provider changes. The browser shows the latest 200 messages; each model request has bounded recent/relevant context, not perfect recall. Temporary notes remain until removed. Back up this private plaintext directory privately if moving the app; it is excluded from Git. Do not run multiple servers against the same directory. A custom `ALEX_DATA_DIR` must also be kept private and untracked.

Proactive updates and daily briefings are off by default. Enabling them authorizes model requests while the server runs. Quiet hours, intervals, successful-delivery deduplication and retry backoff prevent repeated notifications. Updates appear in chat and an unread badge; there is no phone push or schedule while the server is stopped. **Brief me now** explicitly requests a model-generated briefing independent of scheduled quiet hours.

**Sophia** provides an explicitly approved local request/clarification queue. Sophia is not operational, and pending requests are labeled awaiting adapter. Queue approval stores the exact request; it does not execute/deliver work or approve future consequential actions. Alex has no command, deployment or arbitrary tool executor. The **Log** tab shows real local events and sanitized action/error records. The old dashboard activity panel remains clearly labeled sample data.

## Security and offline behavior

Alex is a local single-user service, not a public authenticated deployment. API host/origin/session/CSRF checks restrict chat to the same-device localhost dashboard. LAN office viewing still works, but LAN access to Alex is rejected. The PWA can cache the office app shell; it never caches the API and does not make offline AI inference possible. Static-only hosting cannot run Alex. Keys stay server-side, and sensitive memory is not encrypted at rest.

## Validation

```sh
npm run typecheck
npm test
npm run build
```

Typecheck covers both frontend and server/tests. Production build also runs typecheck. Tests are deterministic isolated fixtures; they do not prove a live AI connection or humor quality. Vite retains the existing large 3D-bundle warning. See [Alex architecture](../../docs/ALEX_ARCHITECTURE.md) for contracts, persistence, privacy, provider and future Sophia/Nexus integration details.

## Phase 2 provider connections

A separate backend CLI now manages multiple OpenRouter, OpenAI-compatible and Ollama connections, with persistent SQLite storage, encrypted credentials and SSRF-protected connection tests:

```sh
npm run providers -- help
npm run providers -- providers
npm run providers -- list
```

Add/edit/test/enable/disable/remove commands and private-stdin credential handling are documented in [Provider Connection Management](../../docs/PROVIDER_CONNECTIONS.md). The default private store is `.local/ai/`, separate from Alex's `.local/alex/`. New connections default to disabled and do not change Alex's active provider. There is no new browser administration surface, dashboard redesign or Nexus integration.

## Automatic model catalog

Dev/production-preview now also start an independent catalog watcher for enabled Phase 2 provider connections. It discovers newly enabled/edited connections and refreshes due inventories without changing Alex's provider. A catalog-worker error leaves Alex and the UI running. Standalone commands:

```sh
npm run catalog -- watch
npm run catalog -- refresh
npm run catalog -- status
npm run catalog -- search '{"search":"llama","pageSize":50}'
```

Search reads persisted metadata and preserves separate account/provider routes. Listings are not verified model access; no inference or automatic spending is performed. Disabled connections are not contacted. See [Model catalog setup and semantics](../../docs/MODEL_CATALOG.md) for pagination, filtering, errors, scheduling and limitations.

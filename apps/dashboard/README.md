# Dashboard and Jef

The existing React + Vite + TypeScript / React Three Fiber office includes Jef (01), a model-backed Personal Communicator runtime, and six placeholder colleagues. No provider/model is configured by default. Selecting Jef’s existing avatar/profile or **Talk to Jef** opens chat; other office/camera/dashboard controls remain available.

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

## Capacitor Android app

The Android project is in `android/`; the React/Vite source remains in `src/` and is editable in Termux or Codex. The APK opens `http://127.0.0.1:3000` **on this same phone**. Run `npm run dev` in Termux for Vite live reload, or run `npm run start` after `npm run build` for a production preview. The dashboard at port 3000 proxies `/api` to the private Node service at `127.0.0.1:3001`; both UI and API have one WebView origin. Start Termux before opening the app and keep it running. The APK does not contain or start the Node backend, provider keys, or a model. If the Termux server stops, the app cannot reach Jef or AI Providers.

```sh
# After editing web source, copy a fresh production build into Android:
npm run android:sync

# With a compatible JDK, Android SDK (API 36) and Gradle downloads available:
npm run android:apk
# Generated debug APK, only after a successful Gradle build:
# android/app/build/outputs/apk/debug/app-debug.apk
```

`android:sync` runs typecheck, Vite production build and `cap sync android`. `android:apk` repeats that sync and invokes the checked-in Gradle wrapper's `assembleDebug`. Install the generated debug APK with `adb install -r android/app/build/outputs/apk/debug/app-debug.apk` from a connected host, or open that APK with Android's package installer on this phone. Debug APKs are for local testing; a distributable release needs your own signing key and release build. Web source changes live reload through Vite while `npm run dev` runs; native config, manifest or dependency changes need `npm run android:sync` and an APK rebuild. A production preview needs a new `npm run build` after web edits. Do not run dev and preview together because both use ports 3000/3001.

Android's manifest grants network access and its network security config permits cleartext HTTP only for `127.0.0.1`; other cleartext destinations are denied. Loopback traffic stays on the phone, while provider requests and secrets remain on the Termux backend. The API still rejects LAN origins and untrusted hosts. Do not change the Capacitor URL to a LAN or remote address: this local single-user API has no public authentication. Keep `.env.server` and `.local/` private; never use `VITE_` variables for API keys. See [Android build and connectivity](../../docs/ANDROID_CAPACITOR.md) for setup and verification.

## Connect a real model

1. Copy `.env.example` to `.env.server` in this directory. The server file is ignored by Git. Restrict its permissions to your user (`chmod 600 .env.server`).
2. Configure an accessible text-chat model, either:
   - OpenAI-compatible: `JEF_BASE_URL` (including `/v1` where required), `JEF_MODEL`, and `JEF_API_KEY` (or server process `OPENAI_API_KEY`). The gateway must support Chat Completions with `max_completion_tokens`.
   - Existing local Ollama: `JEF_OLLAMA_URL` (default `http://127.0.0.1:11434`) and `JEF_OLLAMA_MODEL`. Run Ollama separately and install a model yourself. This app never downloads a model silently.
3. Restart `npm run dev` or `npm run start`.
4. Open **Talk to Jef → Settings → Test real connection**. This makes a real model request, may incur provider charges, and stores its generated response. Successful inference is required for online status. When both adapters are configured, select one in Settings; memory is preserved.

Never use `VITE_` variables for secrets or paste keys into chat. Jef can use his saved verified AI Providers assignment through the server-side encrypted connection; legacy environment providers remain available. The **AI Providers** section accepts write-only registry credentials. The model receives conversation context, explicit notes/preferences, authored office/team facts and the project status document. There is no canned chatbot fallback: with no working provider, Jef reports offline/error.

## Memory, updates and permissions

Use **Memory** to save/remove project context, relationships, real shared jokes or temporary task notes. Use **Settings** to save humor/communication preferences, quiet hours/timezone, notification interval and daily briefing time. All live on the local server in `.local/jef/jef.json`, separate from identity and the full transcript, and survive restarts/provider changes. The browser shows the latest 200 messages; each model request has bounded recent/relevant context, not perfect recall. Temporary notes remain until removed. Back up this private plaintext directory privately if moving the app; it is excluded from Git. Do not run multiple servers against the same directory. A custom `JEF_DATA_DIR` must also be kept private and untracked.

Proactive updates and daily briefings are off by default. Enabling them authorizes model requests while the server runs. Quiet hours, intervals, successful-delivery deduplication and retry backoff prevent repeated notifications. Updates appear in chat and an unread badge; there is no phone push or schedule while the server is stopped. **Brief me now** explicitly requests a model-generated briefing independent of scheduled quiet hours.

**Sophia** provides an explicitly approved local request/clarification queue. Sophia is not operational, and pending requests are labeled awaiting adapter. Queue approval stores the exact request; it does not execute/deliver work or approve future consequential actions. Jef has no command, deployment or arbitrary tool executor. The **Log** tab shows real local events and sanitized action/error records. The old dashboard activity panel remains clearly labeled sample data.

## Security and offline behavior

Jef and provider management use a local single-user service, not a public authenticated deployment. API host/origin/session/CSRF checks restrict them to the same-device localhost dashboard. LAN office viewing still works, but LAN API access is rejected. The PWA can cache the office app shell; it never caches the API and does not make offline AI inference possible. Static-only hosting cannot run these services. Saved provider keys are encrypted on the server and never returned; sensitive Jef memory is not encrypted at rest.

## Validation

```sh
npm run typecheck
npm test
npm run build
```

Typecheck covers both frontend and server/tests. Production build also runs typecheck. Tests are deterministic isolated fixtures; they do not prove a live AI connection or humor quality. Vite retains the existing large 3D-bundle warning. See [Jef architecture](../../docs/JEF_ARCHITECTURE.md) for contracts, persistence, privacy, provider and future Sophia/Nexus integration details.

## Phase 2 provider connections

A separate backend CLI manages multiple OpenAI, Anthropic, Google Gemini, OpenRouter, xKiro, custom OpenAI-compatible and Ollama connections, with persistent SQLite storage, encrypted credentials and protected connection tests:

```sh
npm run providers -- help
npm run providers -- providers
npm run providers -- list
```

Use **AI Providers** in the sidebar to add, manage and enable connections, search synchronized models, add an exact model ID manually when discovery is unavailable, explicitly verify capabilities, and save compatible primary/fallback candidates for agents. New connections default to disabled. Connection tests run automatically after creation and relevant changes; enabled model catalogs refresh in the background. Manual models must pass verification before assignment. Custom OpenAI-compatible endpoints can use bearer or `x-api-key` authentication. Stored credentials cannot be viewed; endpoint changes clear them. Verification can incur provider charges and asks for confirmation. See [AI Providers dashboard](../../docs/AI_PROVIDERS_DASHBOARD.md) for the workflow, protected HTTP contract and integration limits.

The same add/edit/test/enable/disable/remove CLI commands and private-stdin credential handling remain documented in [Provider Connection Management](../../docs/PROVIDER_CONNECTIONS.md). The default private store is `.local/ai/`, separate from Jef's `.local/jef/`. A saved verified Jef (01) assignment supplies his runtime model through the protected provider connection, including native Anthropic and Gemini formats. The configured primary is used at startup; only repeated slowness or provider limit signals can trigger a switch to a saved verified fallback before a new request, with an in-chat event. See [Jef assigned runtime](../../docs/JEF_ASSIGNED_RUNTIME.md).

## Automatic model catalog

Dev/production-preview now also start an independent catalog watcher for enabled Phase 2 provider connections. It discovers newly enabled/edited connections and refreshes due inventories without changing Jef's provider. A catalog-worker error leaves Jef and the UI running. Standalone commands:

```sh
npm run catalog -- watch
npm run catalog -- refresh
npm run catalog -- status
npm run catalog -- search '{"search":"llama","pageSize":50}'
```

Search reads persisted metadata and preserves separate account/provider routes. Listings are not verified model access; no inference or automatic spending is performed. Disabled connections are not contacted. See [Model catalog setup and semantics](../../docs/MODEL_CATALOG.md) for pagination, filtering, errors, scheduling and limitations.

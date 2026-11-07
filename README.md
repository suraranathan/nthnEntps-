# nthnEntps

nthnEntps is a 3D office dashboard built with React, TypeScript and Three.js / React Three Fiber. Its seven-person office includes Alex (01), a Personal Communicator agent runtime with interactive chat, persistent structured memory, configurable model adapters and optional proactive briefings. Six colleagues remain placeholders.

Alex requires a configured real model; none is selected or faked by default. The local Node server keeps credentials out of the browser. Start from `apps/dashboard/` using `npm run dev` (Node 24+), then open http://localhost:3000.

See [dashboard setup](apps/dashboard/README.md), [Alex architecture](docs/ALEX_ARCHITECTURE.md), [project status](PROJECT_STATUS.md), and [changelog](CHANGELOG.md) for configuration, current limitations and verification.

The separate `com.nthn` Termux-derived Android app and its custom ARM64 bootstrap build are in [apps/nthn](apps/nthn/README.md). Run the manual `nthn-build-separate.yml` workflow to build its APK. This app remains separate from the dashboard APK.

Phase 2 adds [encrypted provider connection management](docs/PROVIDER_CONNECTIONS.md) and an [automatic searchable model catalog](docs/MODEL_CATALOG.md). Catalog listings preserve separate provider routes and do not claim verified inference access.

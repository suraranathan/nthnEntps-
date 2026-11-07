# Agent notes

## Repositories

- `nthnEntps` (this repo): React/Vite/TypeScript dashboard, Node backend, Capacitor Android app (`com.nthnentps.dashboard`).
- `apps/nthn`: independent Termux-based ARM64 Linux app (`com.nthn`) and its custom bootstrap workflow. It shares this repository with the dashboard but remains a separate Android app.

## Dashboard commands

Run from `apps/dashboard/`. Node 24 or newer is required.

```sh
npm ci
npm test                 # node --test, serial
npm run typecheck        # tsc project + server config
npm run build            # typecheck + Vite production build
npm run android:sync     # build + cap sync android
npm run android:apk      # sync + Gradle assembleDebug
```

On Termux, `node_modules/.bin` shebangs use `/usr/bin/env`, which is absent. Invoke tools through `node` when running locally, for example:

```sh
node node_modules/typescript/bin/tsc -b --pretty
node node_modules/typescript/bin/tsc -p tsconfig.server.json --pretty
node node_modules/vite/bin/vite.js build
```

The dashboard backend must run in Termux on `127.0.0.1:3001`; Vite serves `127.0.0.1:3000` and proxies `/api`. The APK does not bundle the backend.

## Android CI

- `nthnEntps/.github/workflows/android-debug-apk.yml` builds the dashboard APK on pushes to `main`.
- `.github/workflows/nthn-build-separate.yml` builds the custom ARM64 bootstrap and the `com.nthn` Termux APK. It is manual (`workflow_dispatch`).

## Linux environment facts

- The `com.nthn` app is a fork of Termux `v0.119.0-beta.3`; its terminal, PTY, sessions, Ctrl+C and package tools are the real Termux implementations.
- The bootstrap is compiled from pinned `agnostic-apollo/termux-packages` with `TERMUX_APP__PACKAGE_NAME="com.nthn"`. It is not the upstream Termux bootstrap.
- Official Termux repository packages hard-code `/data/data/com.termux/files/usr`. They are not directly compatible with the `com.nthn` prefix. A package must be built with the same prefix (or installed into a proot rootfs) before it can be used.
- Never claim that the dashboard's WebView executes Linux commands. It does not. The native terminal lives in the separate `com.nthn` app.
- Do not add simulated terminal output, fake package installs or mock shell results.

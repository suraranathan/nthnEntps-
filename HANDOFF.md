# NTHN handoff

Updated: 2026-11-06

## What exists

### Dashboard (`nthnEntps`)

- React/Vite/TypeScript dashboard with a Node backend and Capacitor Android project.
- App id: `com.nthnentps.dashboard`.
- Tests: 134 passing, 1 skipped.
- Local typecheck and production build pass.
- Latest verified CI APK: `app-debug.apk`, 4,528,413 bytes, SHA-256 `07a970655e21de2f174391a730f346053155f11528647e3ff7d21473d3a9c591`.
- Commit `144b6ff` ("Complete Alex personality, follow-ups and office layout work") pushed to `main`.

### Linux environment (`rea-termux-analysis`)

- Independent fork of Termux `v0.119.0-beta.3` with application id `com.nthn`.
- Real Termux terminal, PTY, sessions and package tools; not a WebView simulator.
- ARM64-only (`arm64-v8a`).
- Custom bootstrap built from pinned `agnostic-apollo/termux-packages` commit `fb44d31f3445d7efd2cee6dada47aa19401c1329` with `TERMUX_APP__PACKAGE_NAME="com.nthn"`.
- Workflow: `.github/workflows/build-separate.yml` (manual `workflow_dispatch`).
- Commits `6561a6e`, `9c9057f` and `a706d5c` force the missing `ncurses-ui-libs` subpackage, allow reuse of a verified bootstrap artifact, and trim the ELF trailer before comparing the embedded bootstrap.
- Verified bootstrap: 103,352,884 bytes, SHA-256 `7433caf798979a446a308c4d82ada6b4461cf519252163ee6ac2616eb7476af8`.
- Verified APK: 107,716,676 bytes, SHA-256 `a4f68cef565664659ae7a115e7dda4c34462d0d58d42c0da3bf5ba16daec2afa`; package `com.nthn`, label `nthn`, ARM64-only, embedded bootstrap matches byte-for-byte.

## Current build

- Bootstrap run: `41833494838` (green bootstrap compile; the Docker wrapper returned a spurious exit 1 after the archive was created). Archive uploaded as artifact `nthn-bootstrap`.
- APK run: `42217391288`, green. It reused the bootstrap via `bootstrap_run_id=41833494838` instead of rebuilding Node.js.
- Bootstrap archive: `bootstrap-aarch64.zip`, 103,352,884 bytes, SHA-256 `7433caf798979a446a308c4d82ada6b4461cf519252163ee6ac2616eb7476af8`, 86 installed packages.
- APK artifact: `nthn-separate-arm64-apk` (ID `13501823023`), containing `nthn-separate.apk` (107,716,676 bytes, SHA-256 `a4f68cef565664659ae7a115e7dda4c34462d0d58d42c0da3bf5ba16daec2afa`) and its badging file.
- APK checks: package `com.nthn`, application label `nthn`, native code `arm64-v8a` only, `verify_apk.py` passed, `apksigner verify` passed, embedded bootstrap matches the built archive.
- Local copy for installation: `/storage/emulated/0/Download/nthn-separate.apk`.
- On-device proot runtime test passed: bash 5.3.3, apt 2.8.1, dpkg 1.22.6, Python 3.12.11, Node v24.5.0, git 2.50.1, persistence, local `.deb` install/purge, terminal input.
- The bootstrap extractor and verifier were fixed: `ncurses-ui-libs` is force-built, and `bin/git`/`bin/python`/`bin/python3` are recognized through `SYMLINKS.txt`.
- Earlier failures (`libtirpc`, host ICU, missing `ncurses-ui-libs`) remain documented below for context.

## Commands

```sh
# Trigger a full bootstrap + APK build
gh workflow run build-separate.yml --ref main -R srrnthn3-a11y/rea-termux-analysis

# Reuse an already verified bootstrap without rebuilding Node.js
gh workflow run build-separate.yml --ref main -R srrnthn3-a11y/rea-termux-analysis -f bootstrap_run_id=<verified-run-id>

# Watch it
gh run list --workflow build-separate.yml -R srrnthn3-a11y/rea-termux-analysis
gh run watch <run-id> -R srrnthn3-a11y/rea-termux-analysis

# Download artifacts
gh run download <run-id> -R srrnthn3-a11y/rea-termux-analysis

# Verify the bootstrap archive
python3 scripts/verify_bootstrap.py packages/bootstrap-aarch64.zip

# Run the bootstrap on-device through proot (real ARM64 execution test)
scripts/test_bootstrap_proot.sh packages/bootstrap-aarch64.zip

# Verify the APK
python3 scripts/verify_apk.py nthn-separate.apk --bootstrap packages/bootstrap-aarch64.zip
```

Dashboard:

```sh
cd apps/dashboard
npm ci
npm test
node node_modules/typescript/bin/tsc -b --pretty
node node_modules/typescript/bin/tsc -p tsconfig.server.json --pretty
node node_modules/vite/bin/vite.js build
```

## Verification method

- `scripts/test_bootstrap_proot.sh` extracts the archive, reconstructs `SYMLINKS.txt`, binds it to `/data/data/com.nthn/files`, and runs the real ARM64 binaries under proot.
- It checks `bash`, `apt`, `dpkg`, `git`, `python`, `node`, filesystem persistence, and installation of a locally built `.deb` whose payload targets the `com.nthn` prefix.
- The proot test is a userspace/runtime check. It is not an APK install and does not prove Android package installation.

## Blockers and constraints

- No root, `su` or `adb` on the device. Installing the APK requires the user to confirm the Android installer prompt.
- Official Termux repository packages hard-code `/data/data/com.termux/files/usr` and are not directly compatible with `com.nthn`. Arbitrary `apt install` from the official repo will produce broken paths. Packages must be built for the `com.nthn` prefix or used inside a proot rootfs.
- The dashboard does not execute Linux commands. The native terminal is in the separate `com.nthn` app.
- Do not add simulated terminal output, fake package installs or mock shell results.

## Next steps

1. Install `/storage/emulated/0/Download/nthn-separate.apk` manually and accept the Android installer prompt (no adb/root available).
2. Launch the `nthn` app and verify the real terminal, Ctrl+C handling, package database, `apt` metadata and file persistence.
3. Keep the dashboard and the Linux app separate; the dashboard WebView does not execute shell commands.
4. Rebuild only when the bootstrap or app source changes. Use `-f bootstrap_run_id=<verified-run>` to reuse a previously verified bootstrap.

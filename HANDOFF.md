# NTHN handoff

Updated: 2026-11-04

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
- Commit `fead949` adds `git`, `python`, `nodejs`, fixes the `libtirpc` Automake `INSTALL` symlink, and isolates the Node.js host ICU build from Android cross-compile flags.

## Current build

- Workflow run: `41766590366` (started 2026-11-04 03:21 UTC).
- Run `41654652900` failed while building Node.js: the host ICU `configure` inherited the bootstrap's Android `CFLAGS`/`CPPFLAGS`/`LDFLAGS` and could not create host executables. `scripts/patch_nodejs_hostbuild.py` now runs the ICU host build in a subshell with those variables removed.
- Earlier run `41639705961` failed at `libtirpc-1.3.6` because its tarball ships `INSTALL` as an absolute symlink to `/usr/share/automake-1.16/INSTALL`, while the custom Automake was installed under `/usr/local`.
- `scripts/install-automake-116.sh` now copies the Automake 1.16 data files to `/usr/share/automake-1.16` before packages are built.
- `scripts/verify_bootstrap.py` now requires `git`, `nodejs`, `python`, `bin/git`, `bin/node`, and the `bin/python`/`bin/python3` symlinks.
- `scripts/test_bootstrap_proot.sh` was validated end-to-end against the upstream Termux bootstrap: real ARM64 `bash`, `apt`, `dpkg`, file persistence, and local `.deb` install/purge all passed.

## Commands

```sh
# Trigger the Linux environment build
gh workflow run build-separate.yml --ref main -R srrnthn3-a11y/rea-termux-analysis

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
python3 scripts/verify_apk.py --apk nthn-debug.apk --bootstrap packages/bootstrap-aarch64.zip
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

1. Wait for run `41654652900`; if it fails, read the failing package log and fix the source/build issue.
2. Download and statically verify the bootstrap archive.
3. Run `scripts/test_bootstrap_proot.sh` on-device and record the output.
4. Confirm the APK job produced `nthn-separate-arm64-apk`; download, hash and verify it.
5. Update `PROJECT_STATUS.md`, `CHANGELOG.md`, `IMPLEMENTATION_PLAN.md` and this file with final hashes.
6. Install the APK manually and test terminal input, Ctrl+C, package database and file persistence in the real app.

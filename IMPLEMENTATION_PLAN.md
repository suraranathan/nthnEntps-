# NTHN implementation plan

Updated: 2026-11-06

## Goal

Deliver a real, installable NTHN Linux environment on Android without replacing working functionality with simulations:

1. A separate ARM64 Termux-based app (`com.nthn`) with a real PTY terminal and real package tools.
2. A custom bootstrap built for the `com.nthn` prefix.
3. A dashboard app (`com.nthnentps.dashboard`) that remains independently buildable and installable.
4. Honest documentation of what works, what is blocked, and how each result was verified.

## Phase 1 - Audit and preserve existing work

- [x] Audit both repositories and identify the dashboard vs Termux-app boundary.
- [x] Confirm the dashboard is a Capacitor app, not a terminal.
- [x] Confirm `com.nthn` uses the real Termux terminal/PTY/session implementation.
- [x] Confirm the bootstrap is built from pinned `agnostic-apollo/termux-packages` with `com.nthn`.
- [x] Keep the dashboard test suite, typecheck and production build green.
- [x] Commit and push dashboard work (`144b6ff`).

## Phase 2 - Make the custom bootstrap build reproducibly

- [x] Remove the stale APT checksum rewrite (`22e594d`).
- [x] Fix stale source URLs (`dos2unix`, `nano`, GNU mirror).
- [x] Add `verify_bootstrap.py` and `verify_apk.py` and wire them into CI.
- [x] Add `git`, `python`, `nodejs` to `PACKAGES_POST_ADDITIONAL_LIST`.
- [x] Fix `libtirpc`'s absolute `INSTALL` symlink by populating `/usr/share/automake-1.16`.
- [x] Complete a green bootstrap run (`41833494838`).
- [x] Verify the built bootstrap archive with `scripts/verify_bootstrap.py`.
- [x] Run the bootstrap under proot on-device with `scripts/test_bootstrap_proot.sh`.
- [x] Confirm `bash`, `apt`, `dpkg`, `git`, `python`, `node`, file persistence and local `.deb` installation.

## Phase 3 - Build and verify the `com.nthn` APK

- [x] Download the bootstrap artifact into `termux-src/app/src/main/cpp/`.
- [x] Build `assembleDebug` with the `com.nthn` patch applied.
- [x] Verify package name, ARM64-only ABI and embedded bootstrap with `verify_apk.py`.
- [x] Publish `nthn-separate-arm64-apk` with SHA-256.
- [ ] Install on-device (requires explicit user action; no adb/root available). APK copied to `/storage/emulated/0/Download/nthn-separate.apk`.

## Phase 4 - Dashboard integration

- [ ] Keep the dashboard APK independently installable.
- [ ] Add a documented link/handoff to the separate `com.nthn` terminal app.
- [ ] Do not route dashboard WebView calls to a shell; the backend does not execute Linux commands.

## Phase 5 - Documentation and handoff

- [x] Update `PROJECT_STATUS.md` and `CHANGELOG.md` with verified artifacts and hashes.
- [x] Keep `HANDOFF.md`, `IMPLEMENTATION_PLAN.md` and `AGENTS.md` current.
- [x] Record remaining blockers: on-device install consent, official Termux repo prefix incompatibility.

## Definition of done

- Green bootstrap and APK workflows with downloadable artifacts.
- Bootstrap archive passes static verification and a real proot execution test.
- APK is `com.nthn`, ARM64-only, and contains the matching bootstrap.
- Dashboard tests/typecheck/build pass and its APK remains installable.
- Documentation distinguishes verified facts from pending or blocked work.

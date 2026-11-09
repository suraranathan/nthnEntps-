# nthn Android terminal

This directory contains the build patches and verification scripts for the separate `com.nthn` Android terminal. The workflows are at the repository root in `.github/workflows/`. The `nthn-analyze.yml` workflow runs REA 6.8.0 on the official Termux v0.119.0-beta.3 Android 7+ ARM64 APK. It verifies the APK against the SHA-256 of the installed copy before analysis. The JADX engine JAR is pinned to the SHA-256 published in REA's documentation. Results are kept as a short-lived Actions artifact.

## Separate `com.nthn` bootstrap and APK

`nthn-build-separate.yml` builds a real ARM64 Termux-derived app (`com.nthn`) and a bootstrap compiled from pinned `agnostic-apollo/termux-packages` with `TERMUX_APP__PACKAGE_NAME="com.nthn"`.

## Versioning

`VERSION` is the app version source. Before publishing an APK for an app update, increment it sequentially (`0.1`, `0.2`, `0.3`, and so on). The build applies it to Android, publishes `nthn-V<version>.apk` in an artifact named `nthn-V<version>-android-apk`, and attaches the APK itself to the matching GitHub Release for direct installation without extracting an Actions artifact ZIP.

## Interface

`scripts/patch_nthn.py` applies the native NTHN interface during the Android build. The app launches to a minimal Home dashboard with Home, Terminal, AI, Files, and Settings navigation. Light and dark themes are stored in app-private preferences. Home reports the real custom-prefix state, Terminal retains the upstream PTY/session implementation, AI wraps the existing encrypted provider service, and Files is confined to the app's real Linux home directory. The source assets in `branding/` also provide the launcher monogram, notification icon, and local Help page. Internal Java package names and upstream license attribution remain for compatibility and provenance.

The Android patch packages the existing Node provider and Alex coding-agent services into the app and installs the `nthn-ai` and `nthn-agent` terminal commands after the bootstrap is ready. The native AI screen invokes those services through private process pipes. OpenRouter accounts use independently encrypted credentials in `com.nthn` private storage; keys from the separate dashboard app or Termux must be entered again. Add as many accounts as needed from the AI sidebar or with `nthn-ai add-account`; `nthn-ai accounts` lists their safe metadata. Model discovery and automatic selection search the combined active account catalogs, perform real inference verification, and save the exact account-bound route.

Alex operates on the real `/data/data/com.nthn/files/home` workspace. He can list, read and search project files, then propose edits, builds, tests and allowlisted terminal commands. Every file mutation or executable action pauses for explicit approval, and the exact pending action survives an app or Node-process restart. Paths remain confined to Linux home; provider storage, credentials, `.env`, `.git`, SSH material and symlink escapes are blocked. Tool output is real output from the Linux process and is returned to the model for the next step. Run `nthn-agent state` for a terminal-readable agent snapshot or `nthn-ai help` for provider operations. This does not require Termux to be installed.

`nthn-test-app.yml` checks that the patched app compiles using an upstream bootstrap for compile testing only. `nthn-build.yml` is a legacy label-only build and does not produce `com.nthn`. Use `nthn-build-separate.yml` for the actual app.

Verified on 2026-11-06:

- Bootstrap `41833494838`: `bootstrap-aarch64.zip`, 103,352,884 bytes, SHA-256 `7433caf798979a446a308c4d82ada6b4461cf519252163ee6ac2616eb7476af8`; 86 packages; proot runtime test passed (bash 5.3.3, apt 2.8.1, dpkg 1.22.6, Python 3.12.11, Node v24.5.0, git 2.50.1, persistence, local `.deb` install/purge).
- APK `42217391288`: `nthn-separate.apk`, 107,716,676 bytes, SHA-256 `a4f68cef565664659ae7a115e7dda4c34462d0d58d42c0da3bf5ba16daec2afa`; package `com.nthn`, label `nthn`, arm64-v8a only; embedded bootstrap matches byte-for-byte; `verify_apk.py` and `apksigner verify` passed.

The verified run IDs above belong to the former `rea-termux-analysis` repository. Run this workflow once without an input to build a bootstrap in `nthnEntps`. Then reuse that new run ID without rebuilding Node.js:

```sh
gh workflow run nthn-build-separate.yml --ref main -R srrnthn3-a11y/nthnEntps
gh workflow run nthn-build-separate.yml --ref main -R srrnthn3-a11y/nthnEntps -f bootstrap_run_id=<nthnEntps-run-id>
```

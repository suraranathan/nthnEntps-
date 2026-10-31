# Capacitor Android build and connectivity

The existing Vite dashboard is the web source. Capacitor 8 wraps it as `com.nthnentps.dashboard` with the display name **nthnEntps**. The Android WebView opens `http://127.0.0.1:3000` on the same Android device as Termux. This is the Vite dev or preview origin; Vite's `/api` proxy forwards to the Node backend bound to `127.0.0.1:3001`. Relative `/api/alex` and `/api/ai` requests, cookies and CSRF headers stay same-origin. Android and Termux use the device loopback network; `localhost` in a remote host or emulator would mean a different device and is not supported by this configuration.

## Run and edit

From `apps/dashboard/` in Termux, run `npm install` and `npm run dev`. Open the APK after port 3000 responds. Vite updates React/CSS in the WebView as source changes; restart `npm run dev` after backend or `.env.server` edits. For a production preview, use `npm run build` followed by `npm run start`. Keep Termux running. Source remains in `src/`, `server/`, and `vite.config.ts`; the Android project is in `android/`. Do not edit copied files in `android/app/src/main/assets/public/` because sync replaces them.

## Build and install

Install a JDK compatible with Capacitor 8, Android SDK Platform 36, Build Tools and command-line tools. Set `JAVA_HOME` and `ANDROID_HOME` or `ANDROID_SDK_ROOT` to those installations. The Gradle wrapper is checked in and downloads its distribution/dependencies on first build. Android Studio on a supported desktop host can build the same `android/` project if the Termux device lacks these tools.

Run `npm run android:sync` after changing web source or Capacitor dependencies. Run `npm run android:apk` to sync then build a debug APK. A successful build writes `android/app/build/outputs/apk/debug/app-debug.apk`; install with `adb install -r ...` or the Android package installer. Rebuild and reinstall after native configuration changes. No APK exists merely because `cap add` or `cap sync` succeeds. For distribution, configure release signing separately and keep the signing key outside Git and the APK source tree.

## Security and connectivity checks

- `android/app/src/main/AndroidManifest.xml` declares `INTERNET` and references `res/xml/network_security_config.xml`. That policy denies cleartext by default and allows it only for the `127.0.0.1` domain. The local HTTP exception is needed for Termux loopback on Android API 24–36. No LAN/remote cleartext exception is configured.
- The WebView URL in `capacitor.config.ts` is exactly `http://127.0.0.1:3000`. The backend listens on `127.0.0.1:3001`, and Vite's `/api` proxy preserves the dashboard Host and Origin for the API's allowlist. The HttpOnly SameSite session and CSRF validation remain active.
- Check `curl -I http://127.0.0.1:3000/` and `curl http://127.0.0.1:3000/api/alex` on the phone while Termux runs. The latter should return a JSON snapshot through the proxy. A POST without session/CSRF must return 403. Verify the installed WebView interactively on the device, including Alex and AI Providers; a Termux curl check alone does not prove WebView rendering or network policy behavior.
- `dist/` and synced Android web assets contain the dashboard only. Keep credentials in Termux `.env.server` or the server's private encrypted provider store. Never put keys in `VITE_` variables, Capacitor config, Android resources, or native source.

The APK does not bundle the backend. If Termux is stopped or Android kills its process, the UI cannot use `/api`; restart Termux. This app is designed for one user's phone and does not expose the API as a remote service.

# NTHN web UI previews

`app-shell.html` is a browser-first concept for `com.nthn` with Jef chat as the opening screen. Home, Terminal, Files, and Settings live in the sidebar; on phones, the sidebar opens from the menu button. Jef has a simple animated face. Tap it to cycle through the animation preview; these are manual previews, not live AI activity. Reduced-motion settings stop automatic animation while preserving distinct static states. Space Grotesk and IBM Plex Mono load from Google Fonts when online, with local fallbacks. This is a visual prototype: it does not connect to the device, run shell commands, read files, or send AI requests.

Open `app-shell.html` directly in a browser, or serve this folder locally and visit `http://127.0.0.1:4173/app-shell.html`:

```sh
python -m http.server 4173 --directory apps/nthn/ui-preview
```

If the server instead serves `apps/nthn/`, visit `http://127.0.0.1:4173/ui-preview/app-shell.html`.

`index.html` is the V1.8 Jef chat UI that the Android build packages as `nthn_chat.html`. Its sidebar contains app navigation and the live AI provider controls; in Android, those navigation items open native Home, Terminal, Files, and Settings screens. The face uses real Jef progress events for thinking and replying. Open it at `http://127.0.0.1:4173/` when serving this folder.

The provider form is visual-only in this preview. It does not store or send API keys.

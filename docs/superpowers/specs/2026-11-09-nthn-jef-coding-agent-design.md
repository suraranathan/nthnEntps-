# NTHN Jef Coding Agent Design

## Intent

Turn the Jef screen in the separate `com.nthn` Android app from a coding-focused chatbot into a real coding agent operating on projects in the app's Linux home. Jef must inspect files, propose and apply scoped edits, run development commands, consume their real output, and continue until the task finishes or user approval is required.

## Goals

- Reuse the dashboard's existing TypeScript `JefAgent`, tool registry, conversation store, decision engine, and model gateway behavior.
- Make `/data/data/com.nthn/files/home` the agent workspace.
- Permit safe reads and searches without interruption.
- Require explicit approval for file writes, edits, tests, builds, and terminal commands in the Android UI.
- Persist conversations and pending approvals across short-lived native-to-Node invocations and app restarts.
- Keep OpenRouter credential storage, model auto-selection, and verified model routing from V0.4.
- Support multiple OpenRouter accounts, each with an independently encrypted credential and catalog, and let Jef select a verified model from their combined routes.
- Package the agent modules in the APK and expose a terminal launcher for diagnostics.

## Non-goals

- Do not grant Android storage access outside the app-private Linux home.
- Do not let Jef access provider databases, API keys, `.env`, SSH keys, or other sensitive files.
- Do not allow shell operators, arbitrary programs, or writes outside the workspace.
- Do not replace the real Termux terminal, bootstrap, or package system.
- Do not add simulated tool output.

## Constraints

- `apps/nthn/VERSION` remains the release version source and must advance from `0.4` to `0.5` for the APK update.
- The Node runtime is the app's custom-prefix Node 24 runtime.
- The Android bridge invokes a short-lived Node process and exchanges one JSON document over private stdin/stdout.
- The APK remains ARM64 and package `com.nthn`.

## Approaches

1. Start the full dashboard server in the app and load its React UI. This reuses the most code but introduces a background HTTP lifecycle, port ownership, CSRF/session plumbing, and dashboard-only assumptions.
2. Build a separate Android-native agent implementation. This gives native control but duplicates the tested agent, permission, storage, and provider logic.
3. Reuse `JefAgent` behind an app-local JSON CLI and extend the existing WebView bridge. This keeps the trusted native/process boundary, reuses the tested engine, and adds only a small mobile adapter. This is the selected approach.

## Design

The Android patch will package both `server/ai` and `server/agent`. A new `nthn-agent-cli.ts` will create the encrypted provider manager, resolve the saved verified route, load the persistent agent conversation store, and construct `JefAgent` with the Linux home as its workspace. It will support state, chat, new-conversation, and approve/deny commands.

The provider CLI will stop treating OpenRouter as a singleton. Adding an account will create a new labelled connection, account listing/removal will be explicit, and automatic model selection will refresh and rank the union of active OpenRouter routes. The saved route remains bound to its connection and revision, so Jef uses the correct account credential; removing or changing that account invalidates only its selected route.

`JefAgent` will accept workspace policy/tool options instead of assuming `apps/dashboard`. Pending approvals will include an expiry and be rebuilt from persisted tool-call records on load, allowing an Android approval to arrive in a later Node process. The mobile profile will make every mutation and command approval-gated.

`NthnBackend` will set the real Linux `HOME`, `PATH`, and agent workspace environment and invoke the agent CLI with separated stdout/stderr. `NthnActivity` and `nthn_chat.html` will render persistent agent messages, tool results, and approval buttons. Approval responses will call the native bridge, execute only the exact stored action, and then allow the model to continue.

## Safety and failure behavior

Paths remain relative, canonicalized, confined to the workspace, and protected against symlink escape. Sensitive names and directories remain unreadable. Commands remain parsed without a shell and restricted to the existing allowlist; the mobile profile additionally asks for approval before any command. Approval IDs expire and are tied to the stored conversation, tool, and arguments. Provider errors and tool failures are returned as visible agent errors without fabricating success.

## Verification

Use red/green tests for configurable mobile policy, restart-safe approvals, selected-route gateway/CLI response shaping, packaging, and WebView approval handling. Then run the complete dashboard test suite, TypeScript checks, patch smoke checks, and the existing GitHub APK workflow. Verify package identity, version, signature, embedded bootstrap, artifact checksum, and copy the final APK to the phone.

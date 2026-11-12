# Jef V2 implementation directive

Status: approved requirements, implementation in progress. This document describes the intended `com.nthn` V2 release; a feature is complete only after its code, tests, and device behavior are verified.

## Objective and app boundary

Jef should operate as the creator's agent across the NTHN app. He should inspect, reason, plan, execute, evaluate, and develop the app using real tools. NTHN's separate dashboard app and Android's kernel or other apps' private data are outside this release's automatic control. Android permissions and installation approval remain enforced by the OS.

## Required capabilities

1. **Reliable provider connection.** The creator enters an API key once through a private native input. Jef suggests or identifies the provider, configures its endpoint, discovers models, performs a real chat request with the same shape used in conversation, and reports an actionable failure. Credentials stay encrypted in private app storage and never appear in chat, logs, commits, or provider prompts. A connection test alone is insufficient when Jef's actual chat still fails.
2. **Free model mode and manual switch.** Default to verified zero-price or compatible local models. Never silently route to paid or unknown-price models in free-only mode. Allow the creator to manually choose an exact provider account and model, and to switch between manual choice and automatic free selection. Show observed rate limits, remaining allowance, and reset times when providers expose them; show “unknown” otherwise. Handle rate limits and unavailable models without bypassing provider rules.
3. **Internet and research.** When the device has a working connection, Jef's network tools use it for web retrieval, search where configured, GitHub, APIs, and compatible package operations. Track sources and distinguish facts from assumptions. Report offline and provider errors clearly. A search provider may still need its own key.
4. **Linux environment and source access.** Jef can inspect and modify allowed files in NTHN's own Linux home, compatible prefix, and selected source workspace, then run real commands and tests. Add a native bridge for inspecting and controlling NTHN's live terminal sessions; a separate process does not automatically own an open PTY. Preserve command output, exit codes, cancellation, timeouts, and audit records. Source edits must be reviewable and reversible.
5. **App awareness and device input.** Expose the current NTHN dashboard screen/state to Jef. Add permission-gated camera capture, foreground location, user-selected shared files, speech input, and spoken output. Give the creator clear controls to start and stop sensing. Whole-device screen capture, if included, uses Android's MediaProjection consent for the active session. Do not represent app state as a captured image unless an image was actually captured.
6. **Creator relationship.** Jef addresses the owner as NTHN's creator according to their preference while remaining accurate about what he is and what access he currently has.
7. **Self-development and GitHub delivery.** Jef can inspect and edit approved source, run tests, create a source/build manifest, and prepare a versioned update. With a separately stored GitHub write credential and explicit review of the diff, branch, and workflow, Jef can commit and push the update, dispatch `.github/workflows/nthn-build-separate.yml`, monitor its run, and retrieve the APK. The APK must pass checksum, package identity, version, and signing checks before Android's installer asks for approval. Preserve rollback information. No source edit changes the installed APK without an Android update.
8. **Existing V1.9 systems.** Preserve chat history, memory and user memory controls, research, task logs, provider management, workspace selection, file editing, command approval, and the in-app update checker.

## Delivery checks

- Reproduce and fix the current `[Request failed: The provider request failed.]` chat failure using real provider behavior. Investigate the separately reported Terminal issue on the device; its exact symptom is still unknown.
- Verify each new bridge/API integration through focused automated tests and on-device checks. Never substitute mock output for Linux commands, camera data, location, provider replies, or GitHub runs.
- Bump `apps/nthn/VERSION` from `1.9` to `2` before building the V2 APK. Keep package identity `com.nthn` and the existing signing certificate.
- Record any missing API key, Android permission, GitHub permission, local toolchain, or external dependency as a remaining requirement rather than marking the feature complete.

The task-by-task working plan is in [2026-11-12-jef-v2.md](superpowers/plans/2026-11-12-jef-v2.md).

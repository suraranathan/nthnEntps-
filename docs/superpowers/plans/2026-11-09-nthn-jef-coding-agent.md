# NTHN Jef Coding Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the existing Jef coding-agent engine to the `com.nthn` Linux home and Android chat with restart-safe approvals.

**Architecture:** Package the dashboard agent modules into the APK, add a JSON CLI adapter using the existing encrypted OpenRouter route, and extend the native/WebView bridge to display tool activity and approve exact actions. Generalize only the existing dashboard assumptions needed by the mobile profile.

**Tech Stack:** TypeScript/Node 24, Java/Android WebView bridge, HTML/CSS/JavaScript, Python build patch, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-09-nthn-jef-coding-agent-design.md`

## Global Constraints

- Workspace is `/data/data/com.nthn/files/home`; paths outside it are inaccessible.
- Credentials and sensitive files remain inaccessible to agent tools.
- Every mobile write, edit, test, build, or terminal command requires explicit user approval.
- No fake terminal output or simulated file operations.
- Release version advances sequentially from `0.4` to `0.5`.

## Review Focus

- Process restart between proposal and approval must preserve the exact action and reject expired/mismatched approval IDs.
- Symlinks, absolute paths, traversal, `.env`, `.git`, `.ssh`, and provider-store paths must remain blocked.
- A provider response containing malformed tool markers must never execute a tool.
- Node warnings/stderr must never corrupt the JSON response consumed by Android.
- A failed or denied tool must be shown accurately and must not be reported as successful.

---

### Task 1: Mobile agent policy and restart-safe approvals

**Files:**
- Modify: `apps/dashboard/server/agent/agent.ts`
- Modify: `apps/dashboard/server/agent/tools.ts`
- Modify: `apps/dashboard/server/agent/permissions.ts`
- Modify: `apps/dashboard/server/agent/store.ts`
- Test: `apps/dashboard/tests/agent.test.ts`

**Interfaces:**
- Produces: configurable `JefAgent` workspace/tool policy and persisted `approvalExpiresAt` tool calls.

- [ ] Write failing tests for full-workspace writes, approval-gated mobile commands, and approval after constructing a fresh agent instance.
- [ ] Run the focused agent tests and confirm the new assertions fail for missing behavior.
- [ ] Add the smallest policy options and approval restoration implementation.
- [ ] Run the focused agent tests and confirm they pass.

### Task 2: Multiple OpenRouter accounts

**Files:**
- Modify: `apps/dashboard/server/ai/nthn-cli.ts`
- Modify: `apps/dashboard/server/ai/nthn-cli-state.ts`
- Test: `apps/dashboard/tests/nthn-provider-cli.test.ts`

**Interfaces:**
- Produces: labelled OpenRouter account creation/list/removal and cross-account automatic model selection with a connection-bound saved route.

- [ ] Write failing tests proving a second configured account is retained and both accounts participate in selection.
- [ ] Run the focused provider CLI tests and confirm the singleton behavior fails them.
- [ ] Implement account commands and combined catalog selection without exposing credentials.
- [ ] Run the focused tests and confirm they pass.

### Task 3: Saved-route agent CLI

**Files:**
- Create: `apps/dashboard/server/agent/nthn-agent-cli.ts`
- Modify: `apps/dashboard/server/agent/gateway.ts`
- Test: `apps/dashboard/tests/nthn-agent-cli.test.ts`

**Interfaces:**
- Consumes: saved route in `.local/ai/selected-route.json`, `ConnectionManager`, `CatalogService`, `AgentChatStore`, and mobile `JefAgent` options.
- Produces: JSON commands `state`, `chat`, `new`, and `approve` with messages, tool calls, and pending approval details.

- [ ] Write failing tests for selected-route response parsing and stable mobile result serialization.
- [ ] Run the focused tests and confirm failure due to missing adapter.
- [ ] Implement a buffered saved-route gateway and CLI command handler without exposing credentials.
- [ ] Run the focused tests and confirm they pass.

### Task 4: APK packaging and native bridge

**Files:**
- Modify: `apps/nthn/scripts/patch_nthn.py`
- Modify: `apps/nthn/branding/app/src/main/java/com/termux/app/NthnAiInstaller.java`
- Modify: `apps/nthn/branding/app/src/main/java/com/termux/app/NthnBackend.java`
- Modify: `apps/nthn/branding/app/src/main/java/com/termux/app/NthnActivity.java`
- Modify: `apps/nthn/ui-preview/index.html`
- Test: `apps/dashboard/tests/nthn-android-agent-contract.test.ts`

**Interfaces:**
- Consumes: agent CLI JSON contract from Task 3.
- Produces: packaged modules, `nthn-agent` terminal launcher, native chat/state/approval calls, and approval controls.

- [ ] Write a failing static contract test for packaged agent modules, private environment variables, native approval bridge, and UI approval controls.
- [ ] Run it and confirm the current chatbot-only APK sources fail.
- [ ] Implement packaging, launchers, native process bridge, persistent-state rendering, and approve/deny UI.
- [ ] Run the contract test and focused TypeScript tests.

### Task 5: Release and end-to-end verification

**Files:**
- Modify: `apps/nthn/VERSION`
- Modify: `apps/nthn/README.md`

**Interfaces:**
- Produces: versioned `nthn-V0.5.apk` release and verified phone copy.

- [ ] Update documentation and bump `VERSION` to `0.5`.
- [ ] Run the full dashboard tests, type checks, diff checks, and source patch smoke verification.
- [ ] Review the complete diff for security, data integrity, and Android contract regressions.
- [ ] Commit and push the intended files to `main`.
- [ ] Run the existing separate APK workflow using the latest compatible bootstrap artifact.
- [ ] Verify APK identity, version, signature, bootstrap match, size, and SHA-256.
- [ ] Copy the verified APK to `/sdcard/Download` and open the Android installer.

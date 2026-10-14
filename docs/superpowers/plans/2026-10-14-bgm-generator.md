# BGM Generator Implementation Plan

> For agentic workers: implement independent backend/UI tasks with focused tests, then review the integrated branch.

**Goal:** Generate three 30-second Google Lyria 3 music candidates through fal, preview and export locally preserved MP3s.
**Architecture:** React workspace → restricted preload IPC → durable BgmService + fal queue client. Existing unified shell is the base.
**Tech Stack:** Existing React, TypeScript, Electron, Node built-ins; no new product dependency.
**Spec:** ../specs/2026-10-14-bgm-design.md

## Global constraints
- Separate codex/bgm-generator worktree; preserve other branches.
- Fixed official Lyria 3 schema and USD0.04/audio reference price; test spend strictly below USD5.
- Credentials only main process; existing authentication only.
- Explicit paid submit only, no automatic paid retry. Preserve successful results.

## Review focus
- Interrupted/ambiguous submission must not double charge.
- Restart and expired URL must not prevent exporting a saved MP3.
- A failed candidate must not discard its successful siblings.
- Credential absence and malformed/provider errors must be useful without exposing secrets.
- Invalid IDs, untrusted URLs and renderer calls must not read arbitrary files.

## Tasks
- [x] Backend: tests first for prompt/input, three calls, independent errors, durable ID, uncertain outcome, budget and local export; implement engine/bgm.ts against shared/bgm.ts. Mock network boundary only.
- [x] UI: src/BgmWorkshop.tsx and CSS, toggle accessibility, progress/error cards, audio controls, selection and export. Integrate StudioShell as a React tool, explicitly exclude BGM from native tools.
- [x] Host: authenticated main-process bridge in electron/bgm-host.ts, safe local protocol, preload exposure, reuse existing credential source. No secret storage mutation.
- [x] Verify: focused tests, npm test, build, Electron generation/preview/select/export smoke with deterministic HTTP fixture. Real generation only when existing credentials and price confirmed.
- [ ] Independent review, fix material findings, documentation and Notion pending log, commit, push exact branch and verify remote SHA.

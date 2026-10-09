# Baekho Studio Implementation Plan

**Goal:** Two existing tools in one simple Windows workspace, preserving their data and internal flows.
**Architecture:** React shell and embedded Partsmith App; persistent Combat WebContentsView with an injectable service.
**Tech Stack:** Existing Electron 44, React 19, TypeScript, Node CJS.
**Spec:** ../specs/2026-10-09-baekho-studio-design.md

## Constraints
- Use integration/baekho-studio; preserve all source branches and tool features.
- No automatic paid/AI/Unity execution. Tests use temporary data.
- Keep Partsmith identity and data, separate Combat settings, main-frame IPC allowlists.
- Hide workspaces without destroying them on navigation.

## Tasks and ownership
- [x] Merge the three source branches, preserving original tool README files.
- [x] Combat service and embedded renderer: Desktop/src/main.cjs, preload.cjs, Desktop/renderer, Desktop/tests. Injectable window/webContents/settings, read-only summary, explicit navigation, preserve standalone mode.
- [x] Partsmith embedded mode: src/App.tsx, src/partsmith-embedded.css. Navigation prop with sequence token; project and advanced tools retained.
- [x] Common shell: src/StudioShell.tsx, src/studio.css, src/main.tsx. Shared typed bridge, real lists, loading/errors, two persistent workspaces.
- [x] Host integration: shared/studio.ts, engine/studio-summary.ts, electron/studio-host.ts, electron/main.ts, preload.ts, packaging and focused tests.
- [x] Run both existing suites, build, inspect real Electron UI including persistent drafts and lists, package and smoke test, final independent review.
- [ ] Update README and verification record, commit and push integration branch.

## Review focus
- Rapid navigation during asynchronous view loading must not overlay the wrong screen.
- Untrusted renderer frames cannot invoke tool commands.
- Existing project data and settings survive branding changes.
- Stale/missing reports appear as actionable errors, not success or empty fabricated results.
- Native view bounds follow window changes and all child webContents close with the host.

# Auto-3D-Tool development instructions

## Repository and branch
- This checkout is `https://github.com/lala11112/studio-baekho-tools`.
- Continue this project on branch `Auto-3D-Tool`. Preserve other branches and unrelated work.
- Partsmith is a user-guided asset workbench. Never auto-advance between stages. Flow: GPT (default) or Tripo creates four concept images → user selects one → semantic head/hair/body separation → user reviews/corrects → Tripo Studio Smart Mesh P2 creates four candidates per part with user polygon target → user picks each part → Smart UV/textures → user reviews → Blender + Astra assembly with repeated object-scoped instructions, immutable versions and revert → Blender + Astra rig → synchronized multiview 2D animation frames reviewed by user → Astra authors Blender 3D animation → Unity validation. Existing API tools stay advanced/manual; legacy automatic runs are read-only archives.
- The user's latest animation requirement is multiview 2D animated images/frames, not mandatory video input or a motion-capture service. Use front/side/back frames and explicit timing. Select `gpt-6-astra` for Blender assembly/refinement, rigging and 3D animation as requested; other workers retain the user's configured default. Rigging toggles add object-specific controllable bones/weights for clothing, hair or accessories; OFF still follows the body. Do not add Unity physics unless requested. Never silently replace Astra, reference frames, or authored motion with preset Idle/Walk.
- Treat Smart Mesh P2 in Tripo Studio as the requested default. API P2 Preview support and Studio capabilities are separate. Never silently switch generation models or replay ambiguous submissions. Do not present local demos, task queues, worker-reported checks, or mocked tests as proof of completed high-quality AI production.
- Recover transient errors and repair existing files only within the current user-requested stage, at most three attempts with bounded waits. Preserve successful subphase checkpoints. Recovery of a started phase must not generate new images or submit new Studio charges; untouched subphases may execute their original approved scope. Never auto-advance, auto-resume after cancellation/restart, or replay ambiguous submissions. Use Tripo candidate screenshots for comparison and direct compatible GLB for optional rotation; use Blender conversion only when the downloaded format requires it.
- In separation, known visual quality observations (alignment, scale, alpha edges, appearance) are review warnings, not automatic repair triggers. Preserve failed observations honestly; never turn them into passed checks. Show validated completed part images as non-selectable drafts while remaining parts run. Require three distinct valid parts and explicit user acceptance before modeling. Keep file integrity/path/hash/role/duplicate checks blocking. Explicit saved-photo inspection must not start a worker or generate missing parts.

## Development record — explicit user instruction
- At the end of every completed work item, update the existing Notion page **게임 개발(종합) → Auto-3D-Tool 개발 기록**.
- Page ID: `3f32b4b0-fef7-818b-b2f4-e0616387554e`.
- Page URL: https://app.notion.com/p/3f32b4b0fef7818bb2f4e0616387554e
- Fetch the current page, append a dated entry, and update the current status only where necessary. Preserve earlier entries and other pages.
- Record: completed changes; symptoms and causes; fixes and main files; tests actually run and their results; limitations and remaining work; real commit/PR links when available.
- Distinguish authenticated API checks, paid generation, mocked tests, and local Blender/Unity demos. Never call an unverified paid pipeline complete.
- The user has authorized these project log updates; no repeated permission request is needed. If Notion is unavailable, preserve a local pending entry and clearly report that it has not been published.
- This is a completion workflow, not a scheduled background job.

## Credentials and paid requests
- Never put API keys, decrypted credential values, or authentication headers in source control, logs, screenshots, Notion, or chat.
- Keep DPAPI credentials in the application's existing user data directory.
- Every paid operation must fit an explicit approved scope. API manual tools use per-request approval. Each user-requested Studio stage uses a frozen budget, observed cost, durable pre-click journal, and bounded attempts. Never hardcode the four-model price or silently clamp polygon settings. Do not retry ambiguous submissions automatically.
- International API: `https://openapi.tripo3d.ai/v3`; China API: `https://openapi.tripo3d.com/v3`. Match the key's account region.

## Integrations preference
- Keep Codex built-in integrations and bundled MCP-providing plugins enabled, including node_repl, computer/browser control, Codex app tools, and Sites.
- Keep user-added MCP servers `blender`, `fal_ai`, and `notion` disabled by default. Enable only the required server when explicitly requested or necessary, and disable it again when finished or cancelled. Preserve credentials and unrelated configuration.
- Prefer an already connected Notion plugin when available; do not toggle the separate user-added Notion server unnecessarily.
- Blender processing uses the local executable and Python scripts first.

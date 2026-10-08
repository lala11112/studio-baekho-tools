# Auto-3D-Tool development instructions

## Repository and branch
- This checkout is `https://github.com/lala11112/studio-baekho-tools`.
- Continue this project on branch `Auto-3D-Tool`. Preserve other branches and unrelated work.
- Partsmith automates the whole character production workflow, not a recreation of Tripo's controls. Primary flow: front image → semantic body/head/hair separation → Tripo Studio generation and visual checks → UV/textures → Blender assembly/refinement → final UV/textures and rig → synchronized multiview 2D animation image sequences → Codex Astra creates and inspects Blender 3D animation → Unity validation. Keep existing API tools as advanced manual tools.
- The user's latest animation requirement is multiview 2D animated images/frames, not mandatory video input or a motion-capture service. Use front/side/back frames and explicit timing. Select `gpt-6-astra` for the 3D animation worker as requested; other workers retain the user's configured default. Never silently replace Astra, reference frames, or authored motion with preset Idle/Walk.
- Treat Smart Mesh P2 in Tripo Studio as the requested default. API P2 Preview support and Studio capabilities are separate. Never silently switch generation models or replay ambiguous submissions. Do not present local demos, task queues, worker-reported checks, or mocked tests as proof of completed high-quality AI production.

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
- Every paid operation must fit an explicit approved scope. API manual tools use per-request approval. Automatic Studio work uses a frozen run budget, observed cost, durable pre-click journal, and bounded stage attempts. Do not retry ambiguous submissions automatically.
- International API: `https://openapi.tripo3d.ai/v3`; China API: `https://openapi.tripo3d.com/v3`. Match the key's account region.

## Integrations preference
- Keep Codex built-in integrations and bundled MCP-providing plugins enabled, including node_repl, computer/browser control, Codex app tools, and Sites.
- Keep user-added MCP servers `blender`, `fal_ai`, and `notion` disabled by default. Enable only the required server when explicitly requested or necessary, and disable it again when finished or cancelled. Preserve credentials and unrelated configuration.
- Prefer an already connected Notion plugin when available; do not toggle the separate user-added Notion server unnecessarily.
- Blender processing uses the local executable and Python scripts first.

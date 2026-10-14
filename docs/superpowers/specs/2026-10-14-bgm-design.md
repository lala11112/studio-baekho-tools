# BGM generator

Implements the user-approved genre/mood toggles + free text → three 30-second candidates → preview/select/export flow, using fal.ai Google Lyria 3. No extra design questions are needed for routine choices per the delegated request.

Base: integration/baekho-studio at 5d0cb0f. It already contains the unified tools shell. Latest Auto-3D-Tool is inspected separately; do not merge either branch or change item generation. Isolated worktree on codex/bgm-generator.

In-process React BGM workspace, Electron main-process API and durable local JSON ledger/media folder. fal keys remain in main process, reused from environment or existing encrypted app credentials only. No plaintext persistence, no key entry in renderer. Report missing authentication instead of creating credentials.

Endpoint fal-ai/lyria3: prompt (1–5000), enable_safety_checker true; genre/mood/instrumental directions combined into prompt. No invented duration, seed, count or deprecated negative_prompt. 30-second MP3; official price USD0.04/audio checked 2026-10-14. Three submits reserve USD0.12. Test and default cumulative request budget USD4.99. Reserved estimates are not claims of billing settlement.

Persist candidate intent before submitting and request ID immediately after response. Uncertain submissions never retry automatically. Independent outcomes; recovery polls the same ID. Explicit retry only for definitive failures, preserving successful candidates. Save MP3 locally before allowing preview/export; restart never generates new audio. Validate inputs, remote URLs, local paths and IPC sender.

Sources: https://fal.ai/models/fal-ai/lyria3/api and https://fal.ai/models/fal-ai/lyria3 and https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai%2Flyria3 . No quality/rights/loop guarantees.

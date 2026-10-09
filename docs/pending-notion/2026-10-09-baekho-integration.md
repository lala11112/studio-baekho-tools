# 개발 기록 게시 대기 — 2026-10-09 백호툴 통합

저장소 AGENTS.md의 개발 기록 요구를 위한 로컬 대기 원고입니다. Notion에 게시하지 않았습니다. 원본 Auto-3D-Tool 브랜치와 해당 기록 페이지를 변경하지 않았습니다.

- 브랜치: `integration/baekho-studio`
- 구현: 공통 홈/도구/실행/결과/설정, Partsmith 내장, Combat Lab 단일 창 내장, 저장 기록 조회와 복귀, 입력 보존.
- 수정: 내부 화면 너비·대비, Unity 프로젝트 전환 중 보고서 초기화 경합, Windows 최소화 중 작업 영역 크기 처리.
- 주요 파일: `src/StudioShell.tsx`, `src/App.tsx`, `electron/studio-host.ts`, `engine/studio-summary.ts`, `Desktop/src/main.cjs`, `Desktop/renderer/app.js`.
- 검사와 한계: [통합 검증 기록](../STUDIO-VERIFICATION.md). 개발 앱·패키지 EXE의 로컬 fixture 검사이며 유료 생성과 실제 게임 실행은 하지 않았습니다.
- 게시 시 기존 기록을 보존하고 통합 브랜치 작업임을 구분해야 합니다.

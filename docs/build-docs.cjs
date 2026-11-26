'use strict';

// Documentation only. Run from any directory: node docs/build-docs.cjs
// No network, package installation, or application/Unity access is required.
const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
const diagrams = path.join(root, 'diagrams');
fs.mkdirSync(diagrams, { recursive: true });
const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colors = {
  blue: ['#eef5ff', '#b5cdeb', '#245b9a'],
  teal: ['#e9f7f3', '#9acfc0', '#16735f'],
  amber: ['#fff5e5', '#e6c58d', '#915c16'],
  purple: ['#f2effb', '#c8bceb', '#6946a3'],
  gray: ['#f3f5f8', '#cdd5e0', '#536477']
};
const text = (x, y, value, size = 18, fill = '#213347', weight = 400, anchor = 'start') =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${weight}" text-anchor="${anchor}">${esc(value)}</text>`;
function box(x, y, w, h, title, lines = [], tone = 'blue') {
  const [fill, stroke, ink] = colors[tone];
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="${fill}" stroke="${stroke}"/>` +
    text(x + 20, y + 34, title, 21, ink, 700) +
    lines.map((line, i) => text(x + 20, y + 65 + 26 * i, line, 17)).join('');
}
const arrow = (points, label = '', lx = 0, ly = 0, dashed = false) =>
  `<polyline points="${points}" fill="none" stroke="#7b8b9e" stroke-width="2.2" stroke-linejoin="round" ${dashed ? 'stroke-dasharray="7 6"' : ''} marker-end="url(#arrow)"/>` +
  (label ? text(lx, ly, label, 16, '#536477', 500, 'middle') : '');
const panel = (x, y, w, h, title) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="18" fill="#fff" stroke="#d8e1ea"/>` + text(x + 22, y + 35, title, 18, '#536477', 700);
function svg(file, title, description, height, body) {
  const prefix = path.basename(file, '.svg');
  const result = `<svg xmlns="http://www.w3.org/2000/svg" width="1120" height="${height}" viewBox="0 0 1120 ${height}" role="img" aria-labelledby="${prefix}-title ${prefix}-desc">
<title id="${prefix}-title">${esc(title)}</title><desc id="${prefix}-desc">${esc(description)}</desc>
<defs><marker id="${prefix}-arrow" markerWidth="9" markerHeight="9" refX="8" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path d="M0 0L8 4L0 8" fill="none" stroke="#7b8b9e" stroke-width="2"/></marker></defs>
<g font-family="Malgun Gothic, Noto Sans KR, Arial, sans-serif"><rect width="1120" height="${height}" rx="20" fill="#f7f9fc"/>${text(30, 40, title, 24, '#1c3449', 700)}${body.replaceAll('url(#arrow)', `url(#${prefix}-arrow)`)}</g></svg>`;
  fs.writeFileSync(path.join(diagrams, file), result + '\n');
}

svg('01-architecture.svg', '시스템의 역할과 연결', '앱이 사용자 검토와 초안을 관리하고 Codex가 후보를 제안하며 Unity가 촬영과 에셋 저장을 수행한다.', 650,
  panel(30, 75, 640, 310, 'WINDOWS 데스크톱 앱') +
  box(55, 130, 180, 145, '화면', ['검색 · 작업 목록', '재생 · 시간 편집', '변경 검토'], 'blue') +
  box(280, 130, 360, 145, '메인 프로세스와 Controller', ['허용 API · IPC 송신자 검사', '순차 분석 · 검토 상태 관리', 'AI와 Unity 요청 · 저장 복구'], 'blue') +
  arrow('235,200 280,200', 'IPC', 258, 187) +
  text(55, 325, 'Store → 프로젝트별 초안 · 이전 분석 · 미확정 저장 ID', 18, '#536477') +
  text(55, 355, '원본 이미지 경로 대신 허용된 PNG의 토큰 URL 사용', 16, '#536477') +
  box(735, 110, 355, 190, 'Codex CLI', ['검색 메타데이터 비교', '촬영 이미지의 히트·전환 제안', '프레임 ID를 선택하는 JSON 응답', '기존 로그인 · 설정된 모델'], 'purple') +
  arrow('640,185 735,185', '입력', 687, 173) +
  arrow('735,235 670,235', '후보', 703, 258) +
  panel(30, 425, 1060, 190, 'UNITY EDITOR') +
  box(55, 480, 270, 105, '파일 mailbox', ['요청 · 응답 · 처리 영수증'], 'gray') +
  box(375, 480, 310, 105, '공용 Editor 패키지', ['검색 · 임포트 · 두 시점 촬영'], 'teal') +
  box(735, 480, 330, 105, '사인검 어댑터', ['공격 매핑 · SO와 Controller 저장'], 'amber') +
  arrow('460,385 460,405 190,405 190,480', 'JSON 파일', 615, 412) +
  arrow('325,530 375,530') + arrow('685,530 735,530')
);

svg('02-workflow.svg', '검색부터 검토와 저장까지', '윗줄은 자동 분석이며 아랫줄은 사용자 검토와 명시적인 저장이다. 분석 완료는 저장 완료가 아니다.', 620,
  text(35, 85, '① 입력과 자동 분석', 18, '#245b9a', 700) +
  box(35, 110, 230, 125, '클립 선택', ['자연어 · 이름 검색', 'FBX · ANIM 가져오기']) +
  box(305, 110, 230, 125, '24fps 전체 촬영', ['두 시점 PNG', '2초 단위 히트 분석'], 'teal') +
  box(575, 110, 230, 125, '60fps 경계 확인', ['시작·종료 주변 촬영', '타격별 경계 재분석'], 'teal') +
  box(845, 110, 240, 125, '전환과 종료 제안', ['전체 동작의 회복 확인', '후보 주변 재촬영'], 'purple') +
  arrow('265,172 305,172') + arrow('535,172 575,172') + arrow('805,172 845,172') +
  arrow('965,235 965,285 150,285 150,365', '분석 완료 → 검토 초안', 550, 273) +
  text(35, 335, '② 사용자 검토와 저장', 18, '#915c16', 700) +
  box(35, 365, 230, 135, '프레임과 시간 검토', ['히트 구간 편집', '추천 채택 · 직접 입력', '불확실한 부분 확인'], 'amber') +
  box(305, 365, 230, 135, '저장 대상 설정', ['기존 수정 · 새 공격', '기존 타격과 대응', '검토 완료 표시'], 'amber') +
  box(575, 365, 230, 135, '변경 미리보기', ['타수 · 피해 · 시간', '원본 변경 · 경고 확인', '저장 가능 여부'], 'amber') +
  box(845, 365, 240, 135, '명시적 저장', ['앱 기본값은 복사 저장', '필요 시 원본 적용', '결과 에셋을 게임에 연결'], 'teal') +
  arrow('265,432 305,432') + arrow('535,432 575,432') + arrow('805,432 845,432') +
  text(35, 553, '작업 상태', 17, '#536477', 700) +
  text(145, 553, '초안 → 촬영 중 → 분석 중 → 검토 → 저장 완료', 19) +
  text(35, 586, '실패·취소는 별도 상태로 보존한다. 분석 후 자동으로 에셋을 저장하지 않는다.', 17, '#536477')
);

svg('03-capture.svg', '독립된 장면에서 두 시점 촬영', '원본 장면의 렌더 계층과 본만 복제하고 단일 클립을 수동 평가하여 게임 스크립트와 물리를 실행하지 않는다.', 610,
  box(35, 105, 300, 160, '저장된 열린 씬', ['Animator · 캐릭터 본 계층', '메시 · 머티리얼 · 선택 무기', '클립 GUID와 하위 에셋 ID'], 'blue') +
  box(410, 105, 335, 160, '촬영용 렌더 계층', ['Transform · 메시 · 스킨 메시', '본과 Avatar 연결', '원본을 Instantiate하지 않음'], 'teal') +
  arrow('335,185 410,185', '복제', 372, 171) +
  box(805, 105, 280, 160, '수동 클립 평가', ['PreviewRenderUtility', '단일 클립 Playable', '지정 시각 SetTime'], 'teal') +
  arrow('745,185 805,185') +
  text(40, 315, '게임 스크립트 · 물리 컴포넌트 · 애니메이션 이벤트 · 루트 모션 실행 제외', 19, '#536477', 500) +
  arrow('945,265 945,350 555,350 555,385') +
  panel(35, 385, 630, 170, '한 시각을 동기화한 두 시점') +
  box(55, 440, 280, 90, '사선 512 × 512', [], 'blue') +
  box(355, 440, 280, 90, '측면 512 × 512', [], 'purple') +
  box(755, 405, 330, 145, '1024 × 512 PNG', ['프레임 ID + 클립 시각', 'frames.json에 경로와 시간', 'Library의 분석 세션에 보존'], 'gray') +
  arrow('665,480 755,480', '합성', 710, 465) +
  text(35, 586, '24fps는 전체 동작, 60fps는 후보 주변을 촬영한다. 시간 기준은 속도 배율 전 클립 초다.', 17, '#536477')
);

const tx = t => 190 + t * 420;
const grid = [0, .5, 1, 1.5, 2].map(t =>
  `<line x1="${tx(t)}" y1="110" x2="${tx(t)}" y2="385" stroke="#d9e1eb" stroke-dasharray="4 6"/>` + text(tx(t), 92, `${t.toFixed(1)}초`, 17, '#536477', 400, 'middle')).join('');
const band = (y, start, end, fill) => `<rect x="${tx(start)}" y="${y}" width="${tx(end) - tx(start)}" height="35" rx="8" fill="${fill}"/>`;
svg('04-timing.svg', '히트와 콤보 전환 및 공격 종료', '2초 클립의 설명용 예시. 두 히트가 끝난 뒤 1.35초에 콤보를 전환하고 1.70초에 공격을 종료한다. 실제 측정값이 아니다.', 570,
  grid +
  text(35, 147, '원본 클립', 19, '#213347', 700) + band(120, 0, 2, '#dce5f0') +
  text(tx(1), 145, '원본 동작 전체 2.00초', 17, '#536477', 500, 'middle') +
  text(35, 217, '히트 활성 구간', 19, '#213347', 700) + band(190, .45, .65, '#5fa5e7') + band(190, 1, 1.2, '#5fa5e7') +
  text(tx(.55), 249, '1타', 17, '#245b9a', 700, 'middle') + text(tx(1.1), 249, '2타', 17, '#245b9a', 700, 'middle') +
  text(35, 312, '공격 유효 시간', 19, '#213347', 700) + band(285, 0, 1.7, '#c6e8dd') +
  `<line x1="${tx(1.35)}" y1="165" x2="${tx(1.35)}" y2="373" stroke="#a77820" stroke-width="3"/>` +
  `<line x1="${tx(1.7)}" y1="165" x2="${tx(1.7)}" y2="373" stroke="#16735f" stroke-width="3"/>` +
  text(tx(1.35), 400, '콤보 전환 1.35초', 17, '#915c16', 700, 'middle') +
  text(tx(1.7), 430, '공격 종료 1.70초', 17, '#16735f', 700, 'middle') +
  text(35, 478, '설명용 예시', 18, '#536477', 700) +
  text(185, 478, '마지막 히트 보존 → 다음 콤보 연결 → 공격 종료', 18) +
  text(35, 516, '종료가 히트를 자르면 저장을 막는다. 수동 조기 콤보는 타격 생략 경고 후 저장할 수 있다.', 17, '#536477') +
  text(35, 545, '종료 뒤에도 원본 클립을 재생해 남은 동작을 확인할 수 있다.', 17, '#536477')
);

svg('05-save-recovery.svg', '검토한 변경의 저장과 중단 복구', '적용 요청 전에 앱이 ID를 저장하고 Unity는 변경 전 저널을 남긴다. 결과 불명 시 재전송 없이 읽기 전용 조회로 복구한다.', 765,
  box(35, 100, 230, 125, '사용자 검토', ['히트 · 시간 · 대상 확정', '검토 완료 표시'], 'amber') +
  box(305, 100, 230, 125, 'previewChange', ['변경 전후 비교', '원본 스냅샷 · changeId'], 'amber') +
  box(575, 100, 230, 125, '앱 초안에 먼저 기록', ['changeId + requestId', 'pendingSave 보존'], 'blue') +
  box(845, 100, 240, 125, 'Unity apply', ['원본 재검사 · 백업', 'applying 저널 → 변경'], 'teal') +
  arrow('265,162 305,162') + arrow('535,162 575,162') + arrow('805,162 845,162') +
  arrow('965,225 965,315', '완료 응답', 1008, 272) +
  box(845, 315, 240, 110, '저장 완료', ['최초 결과 · Undo 보존'], 'teal') +
  arrow('880,225 880,267 690,267 690,315', '결과 불명', 747, 253) +
  box(575, 315, 230, 110, '작업 잠금', ['편집 · 재분석 · 삭제 제한'], 'amber') +
  box(35, 315, 440, 110, '검토 이후 편집 또는 원본 변경', ['기존 미리보기 무효화 → 다시 검토'], 'gray') +
  arrow('690,425 690,465') +
  box(450, 465, 470, 95, '브리지 응답과 saveStatus 조회', ['저장 적용은 자동 재전송하지 않음'], 'blue') +
  arrow('550,560 550,590 190,590 190,625') +
  arrow('685,560 685,590 550,590 550,625') +
  arrow('815,560 815,590 930,590 930,625') +
  box(35, 625, 310, 100, 'complete', ['최초 결과로 저장 완료 복원'], 'teal') +
  box(385, 625, 330, 100, 'preview · rolled-back', ['미적용 확인 → 잠금 해제'], 'blue') +
  box(755, 625, 330, 100, '미확정 또는 복구 필요', ['잠금 유지 · Unity 복구 메뉴'], 'amber')
);

svg('06-data.svg', '클립과 작업 및 저장 기록의 식별', '클립, 작업, 촬영 프레임, 공격 대상, 변경 검토와 통신 요청은 각각 별도의 식별자를 사용한다.', 580,
  box(35, 105, 310, 130, '클립 참조', ['GUID + localId 문자열', '원본 지문 · 길이 · 상태 문맥'], 'blue') +
  box(405, 105, 310, 160, '분석 작업', ['job.id · 상태 · 검토 표시', '히트 구간 · 시간 편집', 'AI 추천 · 이전 분석 버전'], 'blue') +
  box(775, 105, 310, 130, '촬영 프레임', ['배치 UUID가 포함된 ID', '클립 시각 · PNG 경로'], 'teal') +
  arrow('345,170 405,170') + arrow('775,170 715,170') +
  box(35, 355, 310, 155, '공격 대상', ['SO GUID + 직렬화 경로', '기존 타격 sourceIndex', '신규 타격은 -1'], 'amber') +
  box(405, 355, 310, 155, '변경 검토와 저널', ['changeId · 원본 스냅샷', '변경 전후 · 백업', 'preview / applying / complete'], 'amber') +
  box(775, 355, 310, 155, '통신 요청과 영수증', ['requestId · 만료 시각', '명령 · 처리 결과', '동일 ID의 응답 연결'], 'gray') +
  arrow('345,430 405,430') + arrow('560,265 560,355', '검토할 변경', 640, 315) +
  arrow('715,430 775,430') +
  text(35, 550, '이름은 표시용이다. 클립·공격·프레임·저장 요청을 ID로 연결해 동명이인과 중복 적용을 구분한다.', 17, '#536477')
);

// This small renderer intentionally supports only the Markdown used in SYSTEMS.md.
// SVGs are embedded so the resulting HTML can be read as a standalone document.
function inline(source) {
  const code = [];
  let value = source.replace(/`([^`]+)`/g, (_, body) => `\u0000${code.push(`<code>${esc(body)}</code>`) - 1}\u0000`);
  value = esc(value).replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return value.replace(/\u0000(\d+)\u0000/g, (_, n) => code[Number(n)]);
}
function render(markdown) {
  const lines = markdown.replace(/\r/g, '').split('\n');
  const output = [], toc = [];
  let index = 0, sectionCount = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    if (line.startsWith('```')) {
      const language = line.slice(3), block = [];
      while (++index < lines.length && !lines[index].startsWith('```')) block.push(lines[index]);
      output.push(`<pre data-language="${esc(language)}"><code>${esc(block.join('\n'))}</code></pre>`);
      index++; continue;
    }
    const heading = /^(#{1,3}) (.+)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const id = level === 2 ? `section-${++sectionCount}` : `heading-${index}`;
      if (level === 2) toc.push({ id, label: heading[2] });
      output.push(`<h${level} id="${id}">${inline(heading[2])}</h${level}>`);
      index++; continue;
    }
    const picture = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(line);
    if (picture) {
      const imagePath = path.resolve(root, picture[2]);
      if (!imagePath.startsWith(diagrams + path.sep)) throw new Error('Diagram must be inside docs/diagrams');
      output.push(`<figure>${fs.readFileSync(imagePath, 'utf8')}<figcaption>${esc(picture[1])}</figcaption></figure>`);
      index++; continue;
    }
    if (line.startsWith('|')) {
      const rows = [];
      while (index < lines.length && lines[index].startsWith('|')) rows.push(lines[index++]);
      const cells = row => row.slice(1, -1).split('|').map(cell => inline(cell.trim()));
      const [header, , ...body] = rows;
      output.push(`<div class="table-scroll"><table><thead><tr>${cells(header).map(cell => `<th>${cell}</th>`).join('')}</tr></thead><tbody>${body.map(row => `<tr>${cells(row).map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^\d+\. /.test(line)) {
      const items = [];
      while (index < lines.length && /^\d+\. /.test(lines[index])) items.push(lines[index++].replace(/^\d+\. /, ''));
      output.push(`<ol>${items.map(item => `<li>${inline(item)}</li>`).join('')}</ol>`);
      continue;
    }
    const paragraph = [line];
    while (++index < lines.length && lines[index].trim() && !/^(#{1,3} |\||```|!\[|\d+\. )/.test(lines[index])) paragraph.push(lines[index]);
    output.push(`<p>${inline(paragraph.join(' '))}</p>`);
  }
  return { body: output.join('\n'), toc };
}
const { body, toc } = render(fs.readFileSync(path.join(root, 'SYSTEMS.md'), 'utf8'));
const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="AutoHitTimer 0.3.0의 구조와 사용 흐름, AI 분석, Unity 촬영, 저장 및 복구를 그림과 글로 설명합니다.">
<title>AutoHitTimer 시스템 문서</title>
<style>
:root{color-scheme:light;--ink:#24384b;--muted:#657589;--blue:#245b9a;--line:#dce4ed}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:30px}body{margin:0;background:#f2f5f9;color:var(--ink);font:16px/1.85 "Malgun Gothic","Noto Sans KR",Arial,sans-serif;word-break:keep-all;overflow-wrap:anywhere}a{color:var(--blue);text-decoration-thickness:1px;text-underline-offset:4px}a:hover{color:#124577}aside{position:fixed;inset:0 auto 0 0;width:258px;padding:32px 22px;background:#142e43;color:#dbe7f0;overflow-y:auto}aside .brand{font-size:23px;font-weight:700;color:#fff;line-height:1.3}aside .meta{font-size:12px;letter-spacing:.08em;color:#b4c9da;margin:12px 0 26px}aside a{display:block;color:#c7d7e4;text-decoration:none;font-size:13px;line-height:1.6;padding:9px 10px;border-radius:7px}aside a:hover{background:#254257;color:#fff}aside .source{border-top:1px solid #3b5264;margin-top:20px;padding-top:18px}main{margin-left:258px;padding:54px clamp(25px,5vw,76px) 70px;max-width:1580px}.paper{background:#fff;padding:clamp(26px,4vw,60px);border:1px solid var(--line);border-radius:16px;box-shadow:0 8px 35px #24384b08}h1{font-size:clamp(29px,3vw,42px);line-height:1.35;letter-spacing:-.045em;margin:12px 0 24px}h2{font-size:27px;line-height:1.45;letter-spacing:-.035em;margin:65px 0 22px;padding-top:24px;border-top:2px solid #dce7f1}h3{font-size:21px;line-height:1.5;margin:32px 0 14px}p{margin:16px 0}h1+p{font-size:18px;line-height:1.95;color:#41586c}strong{font-weight:700;color:#1c4564}ol{padding-left:25px}li{padding-left:6px;margin:10px 0}figure{margin:24px 0 30px;border:1px solid #e0e7ef;border-radius:14px;overflow:hidden;background:#f7f9fc}figure svg{display:block;width:100%;height:auto}figcaption{font-size:12px;line-height:1.65;color:var(--muted);padding:12px 18px;background:#fff;border-top:1px solid #e0e7ef}.table-scroll{overflow-x:auto;margin:24px 0;border:1px solid var(--line);border-radius:10px}table{width:100%;border-collapse:collapse;font-size:14px;line-height:1.75}th,td{text-align:left;padding:13px 15px;border-bottom:1px solid var(--line);vertical-align:top}th{background:#edf3f8;color:#36536b;font-weight:700}th:first-child,td:first-child{min-width:145px;width:24%}tr:last-child td{border-bottom:none}tbody tr:nth-child(even){background:#fbfcfe}code{background:#eef2f7;border:1px solid #e2e8ef;border-radius:4px;padding:2px 5px;font:0.86em/1.6 Consolas,"Malgun Gothic",monospace;overflow-wrap:anywhere}pre{background:#172c3f;color:#e1edf7;padding:22px 24px;border-radius:10px;overflow-x:auto;line-height:1.75}pre code{background:none;border:0;padding:0;color:inherit;white-space:pre}footer{margin-top:35px;font-size:12px;color:var(--muted)}.eyebrow{color:#557086;font-size:12px;letter-spacing:.12em;font-weight:700}.print{border:1px solid #476073;background:#203c51;color:#fff;border-radius:6px;padding:9px 12px;margin:20px 0;cursor:pointer;font:inherit;font-size:12px}
@media(max-width:1000px){aside{position:static;width:auto;padding:22px 24px}aside nav{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 12px}aside .meta{margin:8px 0 12px}aside .source{display:none}.print{margin:10px 0 0}main{margin:0;padding:22px}.paper{padding:28px}h2{font-size:24px}}
@media(max-width:600px){body{font-size:15px}main{padding:10px}.paper{padding:20px 16px}h1{font-size:29px}h2{font-size:22px}figure{overflow-x:auto}figure svg{min-width:720px}table{font-size:13px;min-width:540px}th,td{padding:11px}aside nav a{font-size:12px}pre{padding:16px}}
@media print{@page{size:A4;margin:16mm}body{background:white;font-size:10.5pt;line-height:1.7}aside{display:none}main{margin:0;padding:0;max-width:none}.paper{border:0;box-shadow:none;padding:0}h1{font-size:27pt}h2{font-size:18pt;margin-top:28pt;break-after:avoid}h3{font-size:13pt;break-after:avoid}figure{break-inside:avoid}figure svg{min-width:0}figcaption{font-size:8pt}.table-scroll{overflow:visible}table{font-size:9pt;min-width:0}tr{break-inside:avoid}th,td{padding:7px}pre{white-space:pre-wrap;break-inside:avoid}pre code{white-space:pre-wrap}a{color:inherit}footer{font-size:8pt}}
</style></head><body>
<aside><div class="brand">AutoHitTimer</div><div class="meta">SYSTEM GUIDE · 0.3.0<br>2026.11.04</div><nav>${toc.map(item => `<a href="#${item.id}">${esc(item.label)}</a>`).join('')}</nav><div class="source"><a href="SYSTEMS.md">Markdown 원본</a><a href="../README.md">프로젝트 README</a></div><button class="print" onclick="window.print()">문서 인쇄</button></aside>
<main><article class="paper"><div class="eyebrow">STUDIO BAEKHO · ENGINEERING DOCUMENTATION</div>${body}</article><footer>AutoHitTimer 0.3.0 · 2026년 11월 4일 기준 · docs/SYSTEMS.md에서 생성 · 외부 글꼴 및 네트워크 요청 없음</footer></main>
</body></html>`;
fs.writeFileSync(path.join(root, 'SYSTEMS.html'), html);
console.log('Generated docs/SYSTEMS.html and 6 SVG diagrams from docs/SYSTEMS.md.');

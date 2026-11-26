"""Build repository-native diagrams and the Korean systems PDF.

Requires Python 3, Pillow, reportlab, pypdf and Windows Malgun Gothic fonts.
Run from any directory: python scripts/Build-SystemDocs.py
The Markdown is the prose source; diagrams below are editable vector originals.
"""
from pathlib import Path
import html
import math
import os
import re
import shutil

from PIL import Image, ImageDraw, ImageFont
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate, Frame, PageTemplate, Paragraph, Spacer, Table,
    TableStyle, Image as PDFImage, PageBreak, KeepTogether,
)
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[1]
DOC = ROOT / 'docs/systems-overview.md'
ASSETS = ROOT / 'docs/images/systems'
OUT = ROOT / 'output/pdf/baekho-studio-systems.pdf'
FONT = Path('C:/Windows/Fonts/malgun.ttf')
BOLD = Path('C:/Windows/Fonts/malgunbd.ttf')
INK = '#142B3A'
MUTED = '#486272'
TEAL = '#007D76'
BLUE = '#365CBC'
GOLD = '#AC641D'
PALE = '#ECF6F3'


class Diagram:
    """Draw the same primitives to editable SVG and a 2x PNG."""
    def __init__(self, name, title, height=550):
        self.name, self.w, self.h, self.scale = name, 1200, height, 2
        self.img = Image.new('RGB', (self.w * 2, self.h * 2), '#F5F8FA')
        self.draw = ImageDraw.Draw(self.img)
        self.svg = [f'<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="{height}" viewBox="0 0 1200 {height}">',
                    f'<title>{html.escape(title)}</title>',
                    '<rect width="100%" height="100%" rx="16" fill="#F5F8FA"/>']
        self.text(32, 24, title, 27, INK, True)

    def text(self, x, y, value, size=21, fill=INK, bold=False, center=False):
        font = ImageFont.truetype(str(BOLD if bold else FONT), size * 2)
        if center:
            width = self.draw.textlength(value, font=font) / 2
            x -= width / 2
        self.draw.text((x * 2, y * 2), value, fill=fill, font=font, anchor='lt')
        self.svg.append(f'<text x="{x:.1f}" y="{y + size:.1f}" font-family="Malgun Gothic, Noto Sans KR, sans-serif" font-size="{size}" font-weight="{700 if bold else 400}" fill="{fill}">{html.escape(value)}</text>')

    def box(self, x, y, w, h, title, lines=(), color=TEAL):
        self.draw.rounded_rectangle((x * 2, y * 2, (x + w) * 2, (y + h) * 2), radius=20,
                                    fill='white', outline=color, width=3)
        self.svg.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10" fill="white" stroke="{color}" stroke-width="1.5"/>')
        self.text(x + 19, y + 16, title, 23, color, True)
        for i, line in enumerate(lines):
            self.text(x + 19, y + 53 + 30 * i, line, 20, INK)

    def arrow(self, pts, color=MUTED, label=None, at=None):
        coords = [(int(x * 2), int(y * 2)) for x, y in pts]
        self.draw.line(coords, fill=color, width=4)
        points = ' '.join(f'{x},{y}' for x, y in pts)
        self.svg.append(f'<polyline points="{points}" fill="none" stroke="{color}" stroke-width="2"/>')
        x, y = pts[-1]
        px, py = pts[-2]
        angle = math.atan2(y - py, x - px)
        a = [(x, y)] + [(x - 12 * math.cos(angle + off), y - 12 * math.sin(angle + off)) for off in (-.5, .5)]
        self.draw.polygon([(int(a0 * 2), int(a1 * 2)) for a0, a1 in a], fill=color)
        self.svg.append(f'<polygon points="{" ".join(f"{a0:.1f},{a1:.1f}" for a0,a1 in a)}" fill="{color}"/>')
        if label:
            self.text(*(at or pts[0]), label, 18, color)

    def save(self):
        ASSETS.mkdir(parents=True, exist_ok=True)
        (ASSETS / f'{self.name}.svg').write_text('\n'.join(self.svg + ['</svg>']), encoding='utf-8')
        self.img.save(ASSETS / f'{self.name}.png', optimize=True)


def diagrams():
    d = Diagram('01-architecture', '앱과 실행을 나누는 구조', 560)
    d.box(30, 90, 350, 135, 'Baekho Studio', ['실험 설계 · AI 후보 · 결과 비교', 'Electron / Windows'])
    d.box(440, 90, 315, 135, '파일 기반 브리지', ['명령 · 응답 · 상태', 'Library/CombatLabBridge'], BLUE)
    d.box(815, 90, 355, 135, 'Unity 공통 실행부', ['검증 · Play Mode · 녹화', '게임 타입과 독립'])
    d.arrow([(380, 156), (440, 156)])
    d.arrow([(755, 156), (815, 156)])
    d.box(815, 300, 355, 155, '게임 어댑터와 세션', ['Four Tiger / Example', '데이터 복제 · 실제 플레이', '피해 이벤트 · 상태 복원'], GOLD)
    d.box(30, 320, 675, 135, '결과 저장소와 새 게임 데이터', ['CombatLabResults : 영상 · 실제 캡처 · 측정값 · 판단', '새 .asset : 단일 프리셋 또는 여러 동작의 폼 SO'])
    d.arrow([(990, 225), (990, 300)])
    d.arrow([(815, 380), (705, 380)])
    d.arrow([(180, 320), (180, 225)])
    d.text(32, 500, '앱은 실험 의도를 관리하고, Unity는 수락한 실험의 실행을 소유합니다.', 22, MUTED)
    d.save()

    d = Diagram('02-workflow', '사람이 선택하는 실험 반복', 420)
    labels = [('1 대상 선택', ['프로젝트 · 폼 · 동작']), ('2 후보 작성', ['AI 생성 / 직접 편집']), ('3 실제 실행', ['원본 + 후보별 실행'])]
    for i, (title, lines) in enumerate(labels):
        d.box(30 + i * 395, 90, 350, 110, title, lines)
        if i < 2:
            d.arrow([(380 + i * 395, 145), (425 + i * 395, 145)])
    d.box(820, 270, 350, 110, '4 결과 비교', ['영상 · 명중 PNG · 적용값'], BLUE)
    d.box(425, 270, 350, 110, '5 선택과 이유', ['선호 후보 기록 · 재확인'], BLUE)
    d.box(30, 270, 350, 110, '6 새 SO 저장', ['단일 프리셋 / 통합 폼'], GOLD)
    d.arrow([(995, 200), (995, 270)])
    d.arrow([(820, 325), (775, 325)])
    d.arrow([(425, 325), (380, 325)])
    d.arrow([(600, 270), (600, 200)], label='평가를 반영해 다시 생성·편집', at=(315, 224))
    d.save()

    d = Diagram('03-ai', 'AI 제안과 실행 관측의 연결', 500)
    d.box(30, 90, 345, 220, 'AI에 전달할 입력', ['사용자 목표 · 후보 수', '실제 지원 항목 · 현재값', '가이드 · 레시피 본문', '개선 기준 · 잠금 · 평가'])
    d.box(430, 115, 330, 170, 'Codex CLI', ['구조화된 JSON 출력', '기본 180초 · 취소 가능', '기존 로그인 사용'], BLUE)
    d.box(815, 90, 355, 220, '앱의 출력 검증', ['개수 · ID · 유한 수치 · 범위', '곡선 · 잠금 · 후보 차이', '통과하면 편집과 실행', '실패하면 오류 표시'])
    d.arrow([(375, 195), (430, 195)])
    d.arrow([(760, 195), (815, 195)])
    d.box(200, 370, 800, 95, '사람이 비교하고 개선을 요청', ['저장 측정값과 사용자 평가를 참고하며, 영상 자동 평가 루프는 없음'], GOLD)
    d.arrow([(990, 310), (990, 350), (800, 350), (800, 370)])
    d.arrow([(200, 417), (90, 417), (90, 310)])
    d.save()

    d = Diagram('04-contract', '실험 요청과 선택 항목 패치', 490)
    d.box(30, 90, 430, 155, 'ExperimentRequest', ['어댑터 · 원본 GUID · 동작', '시드 · 시간 · 반복 · 원본 비교', '시나리오 · 영상 · 정밀 캡처'])
    d.box(540, 90, 630, 155, 'Candidate', ['id · label · origin · rationale', 'values : 항목 ID와 절대값', 'curves : 곡선 ID와 2~16개 키'], BLUE)
    d.arrow([(460, 168), (540, 168)], label='1~12', at=(467, 128))
    d.box(30, 325, 430, 125, '실제 연결의 메타데이터', ['지원 ID · 유효 범위 · 추천 범위', '현재값 · 곡선 · 동작 지원 사유'])
    d.box(540, 325, 630, 125, '선택 단계 / HitEvent', ['넉백 · Motion · Impact · Shake · Hitstop', '생략 항목과 편집하지 않은 곡선은 원본 유지'], GOLD)
    d.arrow([(855, 245), (855, 325)])
    d.arrow([(460, 387), (540, 387)])
    d.save()

    d = Diagram('05-bridge', '로컬 명령의 게시와 처리', 490)
    d.box(30, 90, 330, 130, 'Desktop 요청 게시', ['임시 파일 완성 후 rename', 'requests/<id>.json'])
    d.box(435, 90, 330, 130, 'Unity 처리 선점', ['파일 이동으로 소유권 확보', 'processing/<id>.json'], BLUE)
    d.box(840, 90, 330, 130, '검증 후 명령 실행', ['버전 · ID · 만료 · 크기', 'describe / start / export 등'])
    d.arrow([(360, 155), (435, 155)])
    d.arrow([(765, 155), (840, 155)])
    d.box(840, 315, 330, 125, '응답 게시', ['responses/<id>.json', '같은 ID의 실행 영수증'])
    d.box(30, 315, 735, 125, 'Desktop 응답 확인', ['start 수락 후에는 status.json과 report.json에서 진행 확인', '선점된 요청의 시간 초과는 자동 재전송하지 않음'], GOLD)
    d.arrow([(1005, 220), (1005, 315)])
    d.arrow([(840, 378), (765, 378)])
    d.save()

    d = Diagram('06-runner', '후보와 반복마다 새 Play Mode', 590)
    for i, (title, lines) in enumerate([
        ('1 사전 검사', ['요청 · 저장 씬 · 재로드 설정']),
        ('2 입력 고정', ['원본 · 씬 · 컨텍스트 저장']),
        ('3 Play Mode 진입', ['조기 준비 · 씬 초기화'])]):
        d.box(30 + 395 * i, 90, 350, 110, title, lines)
        if i < 2:
            d.arrow([(380 + i * 395, 145), (425 + i * 395, 145)])
    d.box(820, 280, 350, 135, '4 정착과 Arm', ['접지 · 표적 · 카메라 안정', '조건 기록 → 녹화 → 입력'], BLUE)
    d.box(425, 280, 350, 135, '5 실제 실행', ['규칙 기반 입력 · 피해 관측', '영상 · PNG · 실제 적용값'], BLUE)
    d.box(30, 280, 350, 135, '6 저장과 정리', ['보고서 · 상태 복원', 'Edit Mode 복귀'], GOLD)
    d.arrow([(995, 200), (995, 280)])
    d.arrow([(820, 345), (775, 345)])
    d.arrow([(425, 345), (380, 345)])
    d.arrow([(205, 415), (205, 480), (1185, 480), (1185, 145), (1170, 145)])
    d.text(365, 441, '다음 실행은 새 Play Mode 진입 단계부터 반복', 20, MUTED)
    d.text(32, 532, '원본 1회 + 후보 2개 × 3회 = 총 7회 / 같은 시드가 완전한 결정성을 보장하지 않음', 21, MUTED)
    d.save()

    d = Diagram('07-feedback', '공격 진행과 실제 명중을 구분하는 피드백', 525)
    d.box(30, 90, 350, 120, '공격 진행', ['캐릭터 액션 진행도 0~1'])
    d.box(450, 90, 720, 120, 'Motion', ['FOV · 위치 · 회전 곡선 / 추종과 복귀 시계'], BLUE)
    d.arrow([(380, 150), (450, 150)])
    d.box(30, 285, 350, 170, '실제 명중', ['기본 중복 단위 : HitEvent', '피해 적용된 대상 구분', '실시간·게임시간 이벤트'])
    d.box(450, 260, 345, 110, 'Impact / Shake', ['지연 · 지속 · 독립 시계'], BLUE)
    d.box(450, 400, 345, 95, 'Hitstop', ['지속 · 배율 · 대상 · 중첩'], GOLD)
    d.box(850, 275, 320, 190, '정지 대상', ['Global : 세계 시간', 'Attacker : 공격자', 'Victim : 피격자', 'Both : 양쪽'], GOLD)
    d.arrow([(380, 337), (415, 337), (415, 315), (450, 315)])
    d.arrow([(380, 390), (415, 390), (415, 445), (450, 445)])
    d.arrow([(795, 445), (825, 445), (825, 390), (850, 390)])
    d.save()

    d = Diagram('08-capture', '명중 기준의 실제 렌더 샘플', 390)
    d.text(45, 85, '영상과 sidecar는 실시간으로 기록하며, 캡처 간격은 일정하지 않을 수 있습니다.', 22, MUTED)
    d.arrow([(80, 210), (1130, 210)])
    for x in [120, 160, 215, 280, 320, 410, 485, 555, 610, 675, 755, 820, 910, 1010, 1080]:
        d.draw.ellipse((x * 2 - 8, 210 * 2 - 8, x * 2 + 8, 210 * 2 + 8), fill=TEAL)
        d.svg.append(f'<circle cx="{x}" cy="210" r="4" fill="{TEAL}"/>')
    d.arrow([(320, 135), (320, 197)], GOLD)
    d.text(320, 111, '첫 confirmed-impact', 22, GOLD, True, True)
    d.text(120, 242, '-150ms', 20, MUTED, center=True)
    d.text(320, 242, '0ms', 20, GOLD, True, True)
    d.text(1080, 242, '+600ms', 20, MUTED, center=True)
    d.text(600, 304, '정밀 PNG 최대 48장 / 실제 캡처만 저장 / 종료 hold는 별도', 23, INK, True, True)
    d.text(600, 348, '개념도이며 점 간격은 실제 측정 데이터를 나타내지 않습니다.', 19, MUTED, center=True)
    d.save()

    d = Diagram('09-export', '원본 보존과 두 가지 내보내기', 505)
    d.box(30, 180, 320, 130, '원본 폼 SO', ['런타임 실험은 복제본 사용', '원본 자동 채택 없음'])
    d.box(450, 90, 300, 130, '단일 후보', ['선택 동작의 패치', '복제 폼 + 필요 프로필'], BLUE)
    d.box(830, 90, 340, 130, 'CombatLabPreset', ['actionId + actionAsset', '하위 폼을 게임에 연결'], BLUE)
    d.box(450, 320, 300, 130, '동작별 최종 후보', ['같은 원본의 여러 동작', '중복과 충돌 검증'], GOLD)
    d.box(830, 320, 340, 130, '통합 폼 SO', ['실제 폼이 메인 에셋', '파일을 게임에 바로 연결'], GOLD)
    d.arrow([(350, 215), (400, 215), (400, 155), (450, 155)])
    d.arrow([(350, 275), (400, 275), (400, 385), (450, 385)])
    d.arrow([(750, 155), (830, 155)])
    d.arrow([(750, 385), (830, 385)])
    d.text(32, 463, '두 방식 모두 Assets/ 아래의 새로운 .asset으로 저장합니다.', 22, MUTED)
    d.save()


def inline(value, links=True):
    value = html.escape(value)
    value = re.sub(r'`([^`]+)`', r'<font color="#365CBC">\1</font>', value)
    value = re.sub(r'\*\*([^*]+)\*\*', r'<b>\1</b>', value)
    def link(m):
        label, target = m.group(1), html.unescape(m.group(2))
        if not links:
            return label
        if not target.startswith(('https://', 'http://')):
            target = os.path.relpath((DOC.parent / target.split('#')[0]).resolve(), OUT.parent).replace('\\', '/')
        return f'<link href="{html.escape(target, quote=True)}" color="#007D76">{label}</link>'
    return re.sub(r'\[([^\]]+)\]\(([^)]+)\)', link, value)


def pdf():
    pdfmetrics.registerFont(TTFont('Malgun', str(FONT)))
    pdfmetrics.registerFont(TTFont('MalgunBold', str(BOLD)))
    pdfmetrics.registerFontFamily('Malgun', normal='Malgun', bold='MalgunBold', italic='Malgun', boldItalic='MalgunBold')
    styles = getSampleStyleSheet()
    body = ParagraphStyle('KBody', fontName='Malgun', fontSize=9.5, leading=15.6,
                          wordWrap='CJK', textColor=colors.HexColor(INK), spaceAfter=8)
    heading = ParagraphStyle('KH2', parent=body, fontName='MalgunBold', fontSize=20,
                             leading=27, spaceAfter=16, keepWithNext=True)
    small = ParagraphStyle('KSmall', parent=body, fontSize=7.7, leading=11.8,
                           textColor=colors.HexColor(MUTED), spaceAfter=7)
    cell = ParagraphStyle('KCell', parent=body, fontSize=8.1, leading=12, spaceAfter=0)
    cover = ParagraphStyle('Cover', parent=body, fontName='MalgunBold', fontSize=31, leading=43)
    code = ParagraphStyle('Code', parent=body, fontSize=8.3, leading=13, backColor=colors.HexColor('#EEF3F7'), borderPadding=8)
    page_w, page_h = A4
    width = page_w - 86

    class Doc(BaseDocTemplate):
        def afterFlowable(self, flowable):
            if isinstance(flowable, Paragraph) and flowable.style.name == 'KH2':
                title = flowable.getPlainText()
                key = 'section-' + str(self.page)
                self.canv.bookmarkPage(key)
                self.canv.addOutlineEntry(title, key, 0)

    def page(canvas, doc):
        canvas.saveState()
        canvas.setStrokeColor(colors.HexColor('#DAE4E9'))
        canvas.line(43, page_h - 36, page_w - 43, page_h - 36)
        canvas.setFont('Malgun', 8)
        canvas.setFillColor(colors.HexColor(MUTED))
        canvas.drawString(43, page_h - 27, 'BAEKHO STUDIO  /  SYSTEMS')
        canvas.drawRightString(page_w - 43, page_h - 27, '2026.11.04')
        canvas.drawString(43, 25, 'Desktop 0.7.0  ·  Unity package 0.3.0')
        canvas.drawRightString(page_w - 43, 25, str(doc.page))
        canvas.restoreState()

    OUT.parent.mkdir(parents=True, exist_ok=True)
    doc = Doc(str(OUT), pagesize=A4, title='Baekho Studio 시스템 문서', author='Studio Baekho',
              leftMargin=43, rightMargin=43, topMargin=53, bottomMargin=44)
    doc.addPageTemplates(PageTemplate(id='body', frames=Frame(43, 44, width, page_h - 97,
                                                            leftPadding=0, rightPadding=0,
                                                            topPadding=0, bottomPadding=0), onPage=page))
    lines = DOC.read_text(encoding='utf-8').splitlines()
    story = []
    sections = [line[3:] for line in lines if line.startswith('## ')]
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if not line:
            i += 1
            continue
        if line.startswith('# '):
            story += [Spacer(1, 45), Paragraph('SYSTEM DOCUMENTATION', small),
                      Spacer(1, 10), Paragraph(inline(line[2:]), cover), Spacer(1, 16)]
            i += 1
            continue
        if line.startswith('## '):
            if len(story) and not any(isinstance(x, PageBreak) for x in story):
                story += [Spacer(1, 18), Paragraph('문서 구성', heading)]
                for start in range(0, len(sections), 2):
                    pair = sections[start:start + 2]
                    t = Table([[Paragraph(inline(s), small) for s in pair]], colWidths=[width / 2] * len(pair))
                    t.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'TOP'), ('LEFTPADDING', (0, 0), (-1, -1), 0)]))
                    story.append(t)
            story += [PageBreak(), Paragraph(inline(line[3:]), heading)]
            i += 1
            continue
        image_match = re.fullmatch(r'!\[([^\]]+)\]\(([^)]+)\)', line)
        if image_match:
            path = DOC.parent / image_match.group(2)
            with Image.open(path) as im:
                iw, ih = im.size
            max_h = 300 if path.name == 'ui-setup.png' else 247 if 'ui-' in path.name else 230
            ratio = min(width / iw, max_h / ih)
            picture = PDFImage(str(path), width=iw * ratio, height=ih * ratio)
            story += [KeepTogether([picture, Spacer(1, 5), Paragraph(inline(image_match.group(1)), small)]), Spacer(1, 5)]
            i += 1
            continue
        if line.startswith('|'):
            rows = []
            while i < len(lines) and lines[i].strip().startswith('|'):
                items = [x.strip() for x in lines[i].strip().strip('|').split('|')]
                if not all(re.fullmatch(r':?-+:?', x) for x in items):
                    rows.append([Paragraph(inline(x), cell) for x in items])
                i += 1
            n = len(rows[0])
            proportions = [0.27, 0.73] if n == 2 else [0.22, 0.43, 0.35]
            table = Table(rows, colWidths=[width * v for v in proportions], repeatRows=1, hAlign='LEFT')
            table.setStyle(TableStyle([
                ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#E1EFED')),
                ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#F5F8FA')]),
                ('LINEBELOW', (0, 0), (-1, 0), .6, colors.HexColor(TEAL)),
                ('LINEBELOW', (0, 1), (-1, -1), .3, colors.HexColor('#E1E7EC')),
                ('VALIGN', (0, 0), (-1, -1), 'TOP'),
                ('LEFTPADDING', (0, 0), (-1, -1), 7),
                ('RIGHTPADDING', (0, 0), (-1, -1), 7),
                ('TOPPADDING', (0, 0), (-1, -1), 7),
                ('BOTTOMPADDING', (0, 0), (-1, -1), 7),
            ]))
            story += [table, Spacer(1, 12)]
            continue
        if line.startswith('```'):
            code_lines = []
            i += 1
            while i < len(lines) and not lines[i].startswith('```'):
                code_lines.append(html.escape(lines[i]))
                i += 1
            story += [Paragraph('<br/>'.join(code_lines), code), Spacer(1, 8)]
            i += 1
            continue
        paragraph = [line]
        i += 1
        while i < len(lines) and lines[i].strip() and not re.match(r'^(#|!\[|\||```|\d+\. )', lines[i]):
            paragraph.append(lines[i].strip())
            i += 1
        text = ' '.join(paragraph)
        selected_style = small if text.startswith('근거:') else body
        story.append(Paragraph(inline(text), selected_style))
    doc.build(story)
    reader = PdfReader(OUT)
    print(f'Created {OUT.relative_to(ROOT)} ({len(reader.pages)} pages)')
    for index, page_obj in enumerate(reader.pages, 1):
        content = page_obj.extract_text() or ''
        print(f'{index:02d}: {len(content)} chars | ' + content.split('\n')[3][:65])


if __name__ == '__main__':
    if not FONT.exists() or not BOLD.exists():
        raise SystemExit('Install Malgun Gothic or update FONT and BOLD in this script.')
    diagrams()
    for source, dest in [('packaged-v2-final-runtime-setup.png', 'ui-setup.png'),
                         ('packaged-v2-final-runtime-comparison.png', 'ui-comparison.png')]:
        screenshot = ROOT / 'test-artifacts' / source
        if screenshot.exists():
            shutil.copy2(screenshot, ASSETS / dest)
        elif not (ASSETS / dest).exists():
            raise SystemExit(f'Missing source screenshot: {screenshot}')
    pdf()

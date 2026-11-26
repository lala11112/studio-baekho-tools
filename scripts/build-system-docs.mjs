import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Build this repository's system reference without adding a runtime dependency.
// Supported source syntax: headings, paragraphs, flat lists, tables, links,
// strong text, inline code, fenced code, and standalone local SVG images.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'docs/implemented-systems.md');
const destination = path.join(root, 'docs/implemented-systems.html');
const markdown = await readFile(source, 'utf8');
const escape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function inline(text) {
  const tokens = [];
  const token = html => `\u0000${tokens.push(html) - 1}\u0000`;
  let result = text.replace(/`([^`]+)`/g, (_, code) => token(`<code>${escape(code)}</code>`));
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
    if (/^(javascript|data):/i.test(href)) throw new Error(`Unsupported link: ${href}`);
    return token(`<a href="${escape(href)}">${escape(label)}</a>`);
  });
  result = escape(result).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return result.replace(/\u0000(\d+)\u0000/g, (_, index) => tokens[Number(index)]);
}

const lines = markdown.replace(/\r\n/g, '\n').split('\n');
const blocks = [], sections = [];
let title = '', figureCount = 0, headingCount = 0;
const tableCells = row => row.trim().replace(/^\|\s*|\s*\|$/g, '').split('|').map(cell => cell.trim());
for (let i = 0; i < lines.length;) {
  const line = lines[i];
  if (!line.trim()) { i++; continue; }
  const heading = /^(#{1,3}) (.+)$/.exec(line);
  if (heading) {
    const level = heading[1].length, text = heading[2];
    if (level === 1) { title = text; i++; continue; }
    const id = `section-${++headingCount}`;
    if (level === 2) sections.push({ id, text });
    blocks.push(`<h${level} id="${id}">${inline(text)}</h${level}>`); i++; continue;
  }
  const figure = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(line);
  if (figure) {
    const svg = await readFile(path.resolve(path.dirname(source), figure[2]), 'utf8');
    if (!svg.includes('<svg') || /<script\b/i.test(svg)) throw new Error(`Invalid SVG: ${figure[2]}`);
    const dimensions = /viewBox="[^"]*?([\d.]+) ([\d.]+)"/.exec(svg);
    const ratio = dimensions ? `${dimensions[1]} / ${dimensions[2]}` : '1120 / 660';
    blocks.push(`<figure><div class="diagram"><img alt="${escape(figure[1])}" style="aspect-ratio:${ratio}" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></div><figcaption>그림 ${++figureCount} · ${escape(figure[1])}</figcaption></figure>`); i++; continue;
  }
  if (line.startsWith('|') && /^\|[\s:|\-]+$/.test(lines[i + 1] ?? '')) {
    const headers = tableCells(line); i += 2;
    const rows = [];
    while (lines[i]?.startsWith('|')) {
      const cells = tableCells(lines[i++]);
      if (cells.length !== headers.length) throw new Error(`Table column mismatch near line ${i}`);
      rows.push(`<tr>${cells.map(cell => `<td>${inline(cell)}</td>`).join('')}</tr>`);
    }
    blocks.push(`<div class="table-wrap" tabindex="0" role="region" aria-label="표"><table><thead><tr>${headers.map(cell => `<th scope="col">${inline(cell)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`); continue;
  }
  if (line.startsWith('```')) {
    const code = []; i++;
    while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++]);
    if (i === lines.length) throw new Error('Unclosed code block');
    blocks.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`); i++; continue;
  }
  if (/^- /.test(line)) {
    const items = [];
    while (/^- /.test(lines[i] ?? '')) items.push(`<li>${inline(lines[i++].slice(2))}</li>`);
    blocks.push(`<ul>${items.join('')}</ul>`); continue;
  }
  const paragraph = [line]; i++;
  while (i < lines.length && lines[i].trim() && !/^(#{1,3} |!\[|\||- |```)/.test(lines[i])) paragraph.push(lines[i++]);
  blocks.push(`<p>${inline(paragraph.join(' '))}</p>`);
}
if (!title || figureCount !== 7) throw new Error('Expected a title and seven system diagrams');
const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Baekho Map Forge의 생성, 편집, 실측 배치와 Unity 연동을 설명하는 시스템 문서">
<title>${escape(title)}</title>
<style>
:root{--ink:#172b44;--muted:#57677e;--line:#d6dfe9;--accent:#186f78;--blue:#305dd7}*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:32px}body{margin:0;background:#edf1f6;color:var(--ink);font:16px/1.9 'Malgun Gothic','Apple SD Gothic Neo',sans-serif;word-break:keep-all;overflow-wrap:anywhere}a{color:#2453aa;text-decoration:underline;text-underline-offset:3px}a:hover{color:var(--accent)}.skip{position:fixed;left:10px;top:-80px;background:white;padding:12px;z-index:3}.skip:focus{top:10px}.sidebar{position:fixed;inset:0 auto 0 0;width:258px;background:#132840;color:#dce6f3;padding:34px 22px;overflow:auto}.brand{font-size:20px;font-weight:800;line-height:1.4;color:white;margin-bottom:12px}.sidebar small{display:block;color:#b5c8df;font-size:12px;letter-spacing:.12em;margin-bottom:26px}.sidebar a{display:block;color:#dce6f3;font-size:13px;line-height:1.55;padding:8px 0;text-decoration:none}.sidebar a:hover{color:white;text-decoration:underline}.sidebar .source{border-top:1px solid #39516d;margin-top:20px;padding-top:16px}.shell{margin-left:258px;padding:38px 42px 80px}main{max-width:1184px;margin:auto;background:white;border:1px solid var(--line);border-radius:18px;padding:52px 54px;box-shadow:0 10px 34px #172b4408}header{border-bottom:3px solid var(--accent);padding-bottom:28px;margin-bottom:28px}.eyebrow{color:var(--accent);font-size:12px;letter-spacing:.17em;font-weight:700}h1{font-size:37px;line-height:1.4;letter-spacing:-.04em;margin:14px 0 22px}header .tags{display:flex;gap:10px;flex-wrap:wrap}header .tags span{font-size:13px;line-height:1.6;padding:5px 12px;background:#eaf3f3;border-radius:20px;color:var(--accent)}h2{font-size:27px;line-height:1.5;letter-spacing:-.035em;border-top:1px solid var(--line);padding-top:40px;margin:58px 0 23px}h3{font-size:20px;margin:32px 0 14px;color:var(--accent)}p{margin:15px 0}main>p:first-of-type{font-size:19px;line-height:1.9}strong{font-weight:700}code{font-family:Consolas,'Malgun Gothic',monospace;font-size:.88em;background:#eef3f7;border-radius:4px;padding:2px 5px;word-break:break-word}pre{background:#eef3f7;padding:18px;border-radius:10px;overflow:auto}pre code{padding:0}figure{margin:26px 0 32px}.diagram{overflow-x:auto;border:1px solid #dde5ee;border-radius:14px;background:#f5f7fb}.diagram img{display:block;width:100%;height:auto;min-width:740px}figcaption{font-size:13px;line-height:1.65;color:var(--muted);margin:10px 4px 0}.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:10px;margin:24px 0}table{width:100%;border-collapse:collapse;font-size:14px;line-height:1.8;min-width:640px}th{background:#eaf0f7;text-align:left;font-weight:700}th,td{padding:13px 16px;vertical-align:top;border-bottom:1px solid #e2e8ef}td:first-child{font-weight:600}tr:last-child td{border-bottom:0}tbody tr:nth-child(even){background:#fafbfd}ul{padding-left:24px}li{padding:4px 0}footer{margin-top:40px;padding-top:20px;border-top:1px solid var(--line);font-size:13px;color:var(--muted)}
@media(min-width:1700px){.shell{padding-right:80px;padding-left:80px}}@media(max-width:1100px){.sidebar{width:216px;padding:28px 18px}.shell{margin-left:216px;padding:24px}main{padding:32px}h1{font-size:32px}}@media(max-width:800px){.sidebar{position:static;width:auto;padding:20px 24px}.brand{margin:0}.sidebar small{margin:8px 0}.sidebar nav{display:none}.sidebar .source{display:none}.shell{margin:0;padding:14px 10px 40px}main{padding:25px 20px;border-radius:12px}h1{font-size:28px}h2{font-size:24px;margin-top:40px}body{font-size:15px}.diagram img{min-width:740px}figure{margin-left:-6px;margin-right:-6px}}
@media print{@page{size:A4;margin:14mm}.sidebar,.skip,.source-link{display:none}.shell{margin:0;padding:0}body{background:white;font-size:10pt;line-height:1.7}main{max-width:none;border:0;border-radius:0;padding:0;box-shadow:none}h1{font-size:25pt}h2{font-size:18pt;break-after:avoid;margin-top:28px;padding-top:18px}h3{break-after:avoid}figure,tr{break-inside:avoid}.diagram img{min-width:0}figure{margin:18px 0}.table-wrap{overflow:visible}table{font-size:9pt;min-width:0}th,td{padding:7px 9px}a{color:inherit}header{padding-bottom:18px}figcaption{font-size:9pt}}
</style></head><body><a class="skip" href="#content">본문으로 이동</a>
<aside class="sidebar"><div class="brand">BAEKHO<br>MAP FORGE</div><small>SYSTEM REFERENCE</small><nav aria-label="문서 목차">${sections.map(({ id, text }, i) => `<a href="#${id}">${String(i + 1).padStart(2, '0')} &nbsp;${escape(text)}</a>`).join('')}<a class="source" href="implemented-systems.md">Markdown 원문 보기 ↗</a></nav></aside>
<div class="shell"><main id="content"><header><div class="eyebrow">STUDIO BAEKHO · 2026.11.04</div><h1>${escape(title)}</h1><div class="tags"><span>AI 구조 설계</span><span>실측 배치와 편집</span><span>Unity 프리팹과 NavMesh</span></div></header>${blocks.join('\n')}<footer>Baekho Map Forge · 현재 작업 폴더 기준 시스템 설명서 · 개념도 ${figureCount}개</footer></main></div>
</body></html>\n`;
await writeFile(destination, html, 'utf8');
console.log(`Built docs/implemented-systems.html: ${sections.length} sections, ${figureCount} diagrams, ${Buffer.byteLength(html)} bytes`);

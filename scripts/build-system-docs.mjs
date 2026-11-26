// Render the repository system guide without changing application dependencies.
// Uses this guide's small Markdown subset and the existing Playwright dependency.
import {readFile, writeFile, mkdir, access} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {chromium} from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docs = path.join(root, 'docs');
const source = path.join(docs, 'SYSTEMS.ko.md');
const htmlFile = path.join(docs, 'SYSTEMS.ko.html');
const pdfFile = path.join(root, 'output/pdf/Baekho-Enemy-Forge-Systems.ko.pdf');
const qaDir = path.join(root, 'artifacts/system-docs');
const md = await readFile(source, 'utf8');
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const images = new Map();
const links = [];
for (const match of md.matchAll(/(!?)\[([^\]]*)\]\(([^)]+)\)/g)) {
  const [,bang,,target] = match;
  if (/^https?:/.test(target)) continue;
  const resolved = path.resolve(docs, target.split('#')[0]);
  await access(resolved); // Fail on broken local sources or figures.
  links.push(target);
  if (bang) {
    const ext = path.extname(resolved).toLowerCase();
    const type = {'.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml'}[ext];
    if (!type) throw new Error(`Unsupported figure: ${target}`);
    images.set(target, `data:${type};base64,${(await readFile(resolved)).toString('base64')}`);
  }
}

function inline(text) {
  const tokens = [];
  const hold = value => `\u0000${tokens.push(value)-1}\u0000`;
  let result = text.replace(/`([^`]+)`/g, (_,code) => hold(`<code>${esc(code)}</code>`));
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_,label,href) => hold(`<a href="${esc(href)}">${esc(label)}</a>`));
  result = esc(result).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return result.replace(/\u0000(\d+)\u0000/g, (_,n) => tokens[Number(n)]);
}
function blocks(text) {
  const lines = text.trim().split(/\r?\n/), out = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (line.startsWith('```')) {
      const code = []; i++;
      while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++]);
      i++; out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`); continue;
    }
    const heading = /^(#{1,3}) (.+)$/.exec(line);
    if (heading) { out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`); i++; continue; }
    const figure = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(line);
    if (figure) {
      const cls = figure[2].endsWith('.svg') ? 'diagram' : figure[2].includes('preview-drone') ? 'preview' : 'screenshot';
      out.push(`<figure class="${cls}"><img alt="${esc(figure[1])}" src="${images.get(figure[2])}"></figure>`); i++; continue;
    }
    if (line.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      const cells = row => row.slice(1,-1).split('|').map(s=>s.trim());
      out.push(`<table><thead><tr>${cells(rows[0]).map(s=>`<th>${inline(s)}</th>`).join('')}</tr></thead><tbody>${rows.slice(2).map(row=>`<tr>${cells(row).map(s=>`<td>${inline(s)}</td>`).join('')}</tr>`).join('')}</tbody></table>`); continue;
    }
    if (/^(?:- |\d+\. )/.test(line)) {
      const ordered = /^\d/.test(line), items = [];
      const re = ordered ? /^\d+\. / : /^- /;
      while (i < lines.length && re.test(lines[i])) items.push(lines[i++].replace(re, ''));
      const tag = ordered ? 'ol' : 'ul'; out.push(`<${tag}>${items.map(s=>`<li>${inline(s)}</li>`).join('')}</${tag}>`); continue;
    }
    const para = [line]; i++;
    while (i < lines.length && lines[i].trim() && !/^(?:#|\||!\[|```|- |\d+\. )/.test(lines[i])) para.push(lines[i++]);
    const value = para.join(' '), cls = value.startsWith('근거:') ? 'sources' : value.startsWith('그림 ') ? 'caption' : '';
    out.push(`<p${cls ? ` class="${cls}"` : ''}>${inline(value)}</p>`);
  }
  return out.join('\n');
}
const chunks = md.split(/\r?\n(?=## )/);
const titles = chunks.map((chunk,i) => i ? chunk.split(/\r?\n/)[0].replace(/^## /,'') : '문서 소개');
const sections = chunks.map((chunk,i) => `<section class="page ${i ? '' : 'cover'}" id="section-${i}"><header><span>STUDIO BAEKHO / ENEMY FORGE</span><span>SYSTEM GUIDE · 1.2.0</span></header><div class="body"><div class="section-number">${i ? String(i).padStart(2,'0')+' / '+titles[i] : '시스템 문서 · 2026.11.04'}</div>${blocks(chunk)}</div><footer><span>Baekho Enemy Forge · ${esc(titles[i])}</span><span>${String(i+1).padStart(2,'0')} / ${chunks.length}</span></footer></section>`);
const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Baekho Enemy Forge 시스템 문서</title><style>
:root{color-scheme:light;--ink:#253c35;--green:#176b58;--soft:#f1f6f3;--line:#d3dfd9}
*{box-sizing:border-box}body{margin:0;background:#e7eeea;color:var(--ink);font-family:'Malgun Gothic','Noto Sans KR',Arial,sans-serif;font-size:10.2pt;line-height:1.65;word-break:keep-all;overflow-wrap:anywhere}
nav{position:fixed;top:0;left:0;width:248px;height:100vh;overflow:auto;background:#163e35;color:#fff;padding:28px 20px}nav b{display:block;font-size:17px;margin-bottom:5px}nav small{opacity:.65}nav a{display:block;text-decoration:none;color:#deede6;padding:6px 4px;font-size:12px}nav a:hover{color:#f1bc75}nav .actions{margin:18px 0;padding:10px 0;border-block:1px solid #446259}main{margin-left:248px;padding:24px}.page{width:182mm;height:267mm;background:#fff;margin:0 auto 24px;padding:0;display:flex;flex-direction:column;box-shadow:0 8px 24px #183b3620;outline:14mm solid white;border-radius:1px;position:relative;margin-top:14mm;margin-bottom:28mm}
header,footer{display:flex;justify-content:space-between;align-items:center;font-size:7.5pt;letter-spacing:.5px;color:#60756c;flex-shrink:0}header{padding-bottom:3mm;border-bottom:1px solid var(--line);margin-bottom:6mm}footer{padding-top:3mm;border-top:1px solid var(--line);margin-top:5mm}.body{flex:1;min-height:0}.section-number{font-size:8pt;color:var(--green);font-weight:700;letter-spacing:.8px;margin-bottom:2mm}
h1,h2,h3{color:#163e35;line-height:1.35;break-after:avoid}h1{font-size:27pt;margin:3mm 0 5mm;letter-spacing:-.7px}h2{font-size:22pt;margin:2mm 0 5mm;letter-spacing:-.6px}h3{font-size:12pt;margin:5mm 0 2mm}p{margin:0 0 3.2mm}strong{font-weight:700;color:#123e31}a{color:#176b58;text-decoration:underline;text-underline-offset:2px}code{font-family:Consolas,'Malgun Gothic',monospace;font-size:.91em;background:#f0f4f1;padding:0 3px;border-radius:3px;word-break:break-word}pre{background:#f1f6f3;border:1px solid var(--line);padding:4mm;border-radius:3mm;line-height:1.7;font-size:9pt;white-space:pre-wrap}pre code{padding:0;background:none}
table{width:100%;border-collapse:collapse;font-size:9.1pt;line-height:1.55;margin:3.5mm 0 4mm;table-layout:auto}th{text-align:left;background:#e7f0eb;color:#163e35;font-weight:700;border-bottom:1px solid #b5cbc0}td,th{padding:2.1mm 2.4mm;vertical-align:top;border-bottom:1px solid #dce5df}tr:nth-child(even) td{background:#f8faf9}td:first-child{font-weight:600;min-width:25mm}table code{font-size:.9em}ul,ol{padding-left:6mm;margin:2mm 0 4mm}li{margin:1mm 0}
figure{margin:4mm 0 1.5mm;break-inside:avoid}figure img{display:block;width:100%;height:auto;border:1px solid #d3dfd9;border-radius:2mm}.preview img{width:64mm;margin:auto}.caption{font-size:8pt;line-height:1.5;color:#66786f;margin-bottom:4mm}.sources{font-size:8pt;line-height:1.5;color:#66786f;margin-top:4mm}.cover> .body> p:first-of-type{font-size:14pt;color:#536d61}.cover h3{margin-top:6mm}.cover .screenshot{margin-top:7mm}.compact{font-size:9.7pt}.compact table{font-size:8.6pt}.compact h3{margin-top:4mm}.compact p{margin-bottom:2.2mm}.compact td,.compact th{padding-top:1.5mm;padding-bottom:1.5mm}.compact h2{margin-bottom:4mm}.compact pre{padding:3mm;font-size:8.6pt;line-height:1.5}
@media(max-width:1200px){nav{display:none}main{margin-left:0}}@media(max-width:760px){main{padding:10px}.page{width:100%;height:auto;min-height:0;outline:none;padding:20px;margin:0 0 20px}header{gap:10px}table{font-size:9pt}.body{min-height:auto}}
@page{size:A4;margin:14mm}@media print{body{background:white}nav{display:none}main{margin:0;padding:0}.page{box-shadow:none;outline:none;margin:0;width:182mm;height:267mm;break-after:page;border-radius:0}.page:last-child{break-after:auto}a{color:inherit}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style></head><body><nav><b>BAEKHO</b><small>ENEMY FORGE · 시스템 문서</small><div class="actions"><a href="../output/pdf/Baekho-Enemy-Forge-Systems.ko.pdf">공유용 PDF 열기 ↗</a><a href="SYSTEMS.ko.md">Markdown 원문 ↗</a></div>${titles.map((title,i)=>`<a href="#section-${i}">${i ? String(i).padStart(2,'0') : '시작'}　${esc(title)}</a>`).join('')}</nav><main>${sections.join('\n')}</main></body></html>`;
await mkdir(path.dirname(pdfFile), {recursive:true});
await mkdir(qaDir, {recursive:true});
await writeFile(htmlFile, html, 'utf8');

let browser;
const attempts = process.env.DOCS_BROWSER_PATH
  ? [{executablePath:process.env.DOCS_BROWSER_PATH}]
  : [{}, {channel:'msedge'}, {channel:'chrome'}];
const failures = [];
for (const option of attempts) {
  try {browser=await chromium.launch({...option,headless:true});break;} catch(error){failures.push(error.message.split('\n')[0]);}
}
if (!browser) throw new Error(`No Chromium browser available. Set DOCS_BROWSER_PATH. ${failures.join('; ')}`);
try {
  const page = await browser.newPage({viewport:{width:1440,height:1100},deviceScaleFactor:1});
  const errors=[]; page.on('pageerror',error=>errors.push(error.message));
  await page.goto(pathToFileURL(htmlFile).href);
  await page.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(image=>image.decode()));});
  await page.emulateMedia({media:'print'});
  // Compact only an overflowing page. Keep all pages at a readable type size.
  const compacted = await page.evaluate(()=>[...document.querySelectorAll('.page')].flatMap((sheet,i)=>{
    const body=sheet.querySelector('.body');if(body.scrollHeight>body.clientHeight+2){sheet.classList.add('compact');return [i+1];}return [];
  }));
  const layout = await page.evaluate(()=>[...document.querySelectorAll('.page')].map((sheet,i)=>{
    const body=sheet.querySelector('.body');const box=body.getBoundingClientRect();
    const elements=[...body.querySelectorAll('p,li,td,th,pre,img,h1,h2,h3')];
    return {page:i+1,title:sheet.querySelector('h1,h2').textContent,overflowY:body.scrollHeight-body.clientHeight,
      overflowX:sheet.scrollWidth-sheet.clientWidth,contentBottom:Math.max(...elements.map(e=>e.getBoundingClientRect().bottom))-box.top,available:box.height};
  }));
  const invalid=layout.filter(s=>s.overflowY>2||s.overflowX>2||s.contentBottom>s.available+2);
  if(invalid.length)throw new Error(`Document layout overflow: ${JSON.stringify(invalid)}`);
  if(errors.length)throw new Error(errors.join('\n'));
  // Persist any compact styles so HTML and PDF use the same layout.
  await writeFile(htmlFile, await page.content(), 'utf8');
  await page.pdf({path:pdfFile,preferCSSPageSize:true,printBackground:true,tagged:true,outline:true});
  await page.emulateMedia({media:'screen'});
  for(let i=0;i<sections.length;i++) await page.locator('.page').nth(i).screenshot({path:path.join(qaDir,`page-${String(i+1).padStart(2,'0')}.png`)});
  const report={source:'docs/SYSTEMS.ko.md',pages:sections.length,figures:images.size,checkedLocalLinks:links.length,compacted,layout,outputs:['docs/SYSTEMS.ko.html','output/pdf/Baekho-Enemy-Forge-Systems.ko.pdf']};
  await writeFile(path.join(qaDir,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
} finally {await browser.close();}

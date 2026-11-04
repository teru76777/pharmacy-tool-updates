// 列印記憶.txt 檢視頁：已設定 TXT 存放資料夾時直接讀取檔案內容；否則顯示標籤工具內的列印記憶
const MEMVIEW_KEY = 'cart-label-memview-v1', MEMFILE_NAME = '列印記憶.txt', MEMFILE_DB = 'cart-label-memfile';
const $ = id => document.getElementById(id);
let dir = null, current = '', busy = false;

function stamp(ms) {
  if (!ms) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
function decode(buffer) {
  const b = new Uint8Array(buffer);
  if (b[0] === 255 && b[1] === 254) return new TextDecoder('utf-16le').decode(b);
  if (b[0] === 254 && b[1] === 255) return new TextDecoder('utf-16be').decode(b);
  return new TextDecoder('utf-8').decode(b).replace(/^﻿/, '');
}
function snapshot() { try { return JSON.parse(localStorage.getItem(MEMVIEW_KEY) || 'null'); } catch { return null; } }
function getDir() {
  return new Promise(res => {
    let r; try { r = indexedDB.open(MEMFILE_DB, 1); } catch { res(null); return; }
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onerror = () => res(null);
    r.onsuccess = () => {
      const db = r.result;
      try { const q = db.transaction('kv').objectStore('kv').get('dir'); q.onsuccess = () => { db.close(); res(q.result || null); }; q.onerror = () => { db.close(); res(null); }; }
      catch { db.close(); res(null); }
    };
  });
}
function source(lines, { warn = false, allow = false } = {}) {
  const box = $('source'); box.replaceChildren(); box.classList.toggle('warn', warn);
  lines.filter(Boolean).forEach((t, i) => { if (i) box.append(document.createElement('br')); const s = document.createElement(i ? 'span' : 'strong'); s.textContent = t; box.append(s); });
  if (allow) { box.append(document.createElement('br')); const b = document.createElement('button'); b.className = 'primary'; b.textContent = '允許讀取檔案'; b.onclick = () => load(true); box.append(b); }
}
function showText(t) { current = t; $('text').textContent = t; }
function showSnapshot(reason, opts = {}) {
  const s = snapshot();
  if (s?.text) { showText(s.text); source([reason, `以下為標籤工具內的列印記憶（${stamp(s.at)} 更新）。`], { warn: true, ...opts }); }
  else { showText(''); source([reason, '目前沒有列印記憶的內容，請先開啟標籤工具。'], { warn: true, ...opts }); }
}
async function readFile(gesture) {
  const o = { mode: 'read' }; let p = 'prompt';
  try { p = await dir.queryPermission(o); if (p !== 'granted' && gesture) p = await dir.requestPermission(o); } catch {}
  if (p !== 'granted') { showSnapshot(`已設定資料夾「${dir.name}」，需要允許才能讀取 ${MEMFILE_NAME}。`, { allow: true }); return; }
  try {
    const f = await (await dir.getFileHandle(MEMFILE_NAME)).getFile();
    showText(decode(await f.arrayBuffer()));
    source([`檔案：資料夾「${dir.name}」\\${MEMFILE_NAME}`, `最後修改 ${stamp(f.lastModified)}；回到此分頁或按「重新整理」會重新讀取。`]);
  } catch (e) {
    showSnapshot(e?.name === 'NotFoundError' ? `資料夾「${dir.name}」中找不到 ${MEMFILE_NAME}（可能已刪除或移動；回標籤工具記錄一次列印就會重建）。` : `無法讀取 ${MEMFILE_NAME}：${e?.message || e}`);
  }
}
async function load(gesture = false) {
  if (busy) return; busy = true;
  try {
    if (dir) await readFile(gesture);
    else showSnapshot('尚未設定 TXT 存放資料夾（標籤工具 → ⚙ 設定 → 列印記憶 → 設定 TXT 存放資料夾）。');
  } finally { busy = false; }
}

$('refresh').onclick = () => load(true);
$('copy').onclick = async () => { try { await navigator.clipboard.writeText(current); $('copy').textContent = '已複製'; setTimeout(() => $('copy').textContent = '複製', 1500); } catch {} };
$('download').onclick = () => {
  const url = URL.createObjectURL(new Blob(['﻿', current], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = MEMFILE_NAME; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
window.addEventListener('focus', () => load(false));
window.addEventListener('storage', e => { if (e.key === MEMVIEW_KEY && !dir) load(false); });
(async () => { try { dir = await getDir(); } catch {} await load(false); })();

// 列印記憶 TXT：選一次資料夾後，每次記錄列印都自動更新「列印記憶.txt」，可用記事本查看或修改。
// 只寫入列印日期、病房、床號、病歷號（帳號版標籤為帳號）；空床只寫病房、床號。不含姓名、生日。
// 瀏覽器內的記憶（localStorage）照常運作；TXT 被手動修改時，下次開啟或按列印時以 TXT 為準。
const MEMFILE_NAME = '列印記憶.txt';
const MEMFILE_DB = 'cart-label-memfile';
const MEMFILE_STATE_KEY = 'cart-label-memfile-state-v1'; // 上次寫入的檔案時間、大小、日期
const MEMVIEW_KEY = 'cart-label-memview-v1'; // 給 memory.html（列印記憶.txt 檢視頁）用的最新內容
const memSupported = typeof window.showDirectoryPicker === 'function';
let memDir = null, memPerm = 'none', memNote = '', memBlocked = false, memInSync = false, memQueue = Promise.resolve();

// ---------- 小工具 ----------
function memStamp(ms = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
function memWeekday(day) { return '日一二三四五六'[new Date(day + 'T00:00:00Z').getUTCDay()]; }
function memRowKey(r) { return r.vacant ? r.day + '|V|' + vacantKey(r.ward, r.bed) : r.day + '|' + r.account; }
function memState() { try { return JSON.parse(localStorage.getItem(MEMFILE_STATE_KEY) || '{}') || {}; } catch { return {}; } }
function memSetState(v) { try { v ? localStorage.setItem(MEMFILE_STATE_KEY, JSON.stringify(v)) : localStorage.removeItem(MEMFILE_STATE_KEY); } catch {} }
function memStoredRows() { try { return retainedHistory(JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]')); } catch { return []; } }
function memSaveRows(rows) { localStorage.setItem(HISTORY_KEY, JSON.stringify(retainedHistory(rows))); }
function memDecode(buffer) {
  const b = new Uint8Array(buffer);
  if (b[0] === 255 && b[1] === 254) return new TextDecoder('utf-16le', { fatal: true }).decode(b);
  if (b[0] === 254 && b[1] === 255) return new TextDecoder('utf-16be', { fatal: true }).decode(b);
  return new TextDecoder('utf-8', { fatal: true }).decode(b);
}

function memSnapshot() { try { localStorage.setItem(MEMVIEW_KEY, JSON.stringify({ text: memoryText(), at: Date.now(), folder: memDir?.name || '' })); } catch {} }
// 開啟 列印記憶.txt 的連結（新分頁 memory.html）
function memTxtLink(label = '開啟 列印記憶.txt', cls = 'text-button') { const a = document.createElement('a'); a.href = 'memory.html'; a.target = '_blank'; a.rel = 'noopener'; a.className = cls + ' mem-txt-link'; a.textContent = label; a.addEventListener('click', memSnapshot); return a; }

// ---------- TXT 格式 ----------
function memoryText(rows = memStoredRows(), today = taiwanDay()) {
  const cmp = comparisonDay(rows, today), byDay = new Map();
  for (const r of rows) { if (!r.account && !r.vacant) continue; if (!byDay.has(r.day)) byDay.set(r.day, []); byDay.get(r.day).push(r); }
  const days = [...byDay.keys()].sort().reverse(), out = [
    '# 藥車標籤列印｜列印記憶（由擴充功能自動更新）',
    '# 只記錄：列印日期、病房、床號、病歷號（帳號版標籤為帳號）；空床只記病房、床號。不含姓名、生日。',
    `# 保留 ${KEEP_DAYS} 天。重複、轉床、空床都比對「前前一次」列印日（今天以前有列印的日期往回數第二天）。`,
    `# 更新時間：${memStamp()}　今天（${today}）列印比對：${cmp || '無（今天以前不到兩個列印日）'}`,
    '# 可用記事本修改（例如刪除印錯的一行），存檔後下次開啟標籤工具或按列印時套用。',
    '# 格式：[日期] 一行，下方每行「病房 床號 病歷號」；空床寫「病房 床號 空床」。# 開頭為註解。',
    ''
  ];
  if (!days.length) out.push('# （目前沒有紀錄）', '');
  for (const day of days) {
    const list = byDay.get(day).sort((a, b) => a.ward.localeCompare(b.ward) || bedCompare(a.bed, b.bed) || (a.vacant ? 1 : 0) - (b.vacant ? 1 : 0));
    const patients = list.filter(r => r.account).length;
    out.push(`[${day}] 週${memWeekday(day)}　病人 ${patients}、空床 ${list.length - patients}${day === cmp ? '　← 今天列印比對此日' : ''}`);
    for (const r of list) out.push([r.ward, r.bed, r.vacant ? '空床' : r.account].join('\t'));
    out.push('');
  }
  return out.join('\r\n');
}
function parseMemoryText(text) {
  if (text.length > 2000000) throw Error('檔案過大（超過 2 MB）。');
  const rows = []; let day = null;
  text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n').forEach((raw, i) => {
    const line = raw.trim(), at = `第 ${i + 1} 行`;
    if (!line || line.startsWith('#')) return;
    const h = line.match(/^\[(\d{4})-(\d{1,2})-(\d{1,2})\]/);
    if (h) {
      day = `${h[1]}-${h[2].padStart(2, '0')}-${h[3].padStart(2, '0')}`;
      const d = new Date(day + 'T00:00:00Z');
      if (isNaN(d) || d.toISOString().slice(0, 10) !== day) throw Error(`${at}：日期 ${h[0]} 無效。`);
      return;
    }
    if (!day) throw Error(`${at}：請先寫日期，例如 [2026-11-04]。`);
    const t = line.includes('\t') ? line.split('\t').map(x => x.trim()).filter(Boolean) : line.split(/\s+/);
    if (t.length < 3) throw Error(`${at}：需為「病房 床號 病歷號」或「病房 床號 空床」。`);
    if (t.length > 3) throw Error(`${at}：欄位過多，只需病房、床號、病歷號（不需姓名、生日）。`);
    const [ward, bed, id] = t;
    if (ward.length > 40 || bed.length > 32) throw Error(`${at}：病房或床號過長。`);
    if (id === '空床' || id === '空') { rows.push({ ward, bed, day, vacant: true }); return; }
    const account = chartId(id);
    if (!account) throw Error(`${at}：病歷號「${id}」無效（至少 6 碼）。`);
    rows.push({ ward, bed, day, account });
  });
  return [...new Map(rows.map(r => [memRowKey(r), r])).values()];
}

// ---------- 資料夾 handle（存在 IndexedDB） ----------
function memDb() { return new Promise((res, rej) => { const r = indexedDB.open(MEMFILE_DB, 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function memIdb(op, value) {
  const db = await memDb();
  try {
    return await new Promise((res, rej) => {
      const st = db.transaction('kv', op === 'get' ? 'readonly' : 'readwrite').objectStore('kv');
      const rq = op === 'get' ? st.get('dir') : op === 'put' ? st.put(value, 'dir') : st.delete('dir');
      rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
    });
  } finally { db.close(); }
}
async function memPermission(gesture) {
  const o = { mode: 'readwrite' }; let p = 'prompt';
  try { p = await memDir.queryPermission(o); if (p !== 'granted' && gesture) p = await memDir.requestPermission(o); } catch { /* 沒有使用者操作時無法詢問 */ }
  memPerm = p; return p === 'granted';
}

// ---------- 同步 ----------
// pull：TXT 被外部修改 → 套用（以 TXT 為準）；write：寫入瀏覽器內的記憶；force：TXT 格式錯誤時仍覆蓋
function memorySync(opts = {}) {
  const run = memQueue.then(() => memSyncNow(opts)).catch(e => {
    memNote = e?.name === 'NotFoundError' ? `找不到資料夾「${memDir?.name || ''}」（可能已移動或刪除），請按「變更資料夾」重新設定。` : '列印記憶.txt 同步失敗：' + (e?.message || e);
    memRender(); return { linked: !!memDir, error: true };
  }).then(r => { memSnapshot(); return r; });
  memQueue = run.then(() => {}, () => {});
  return run;
}
async function memSyncNow({ gesture = false, write = false, pull = true, force = false } = {}) {
  const res = { linked: !!memDir, wrote: false, pulled: false };
  if (!memDir) return res;
  if (!await memPermission(gesture)) { memRender(); return res; }
  memInSync = true;
  try {
    let fh = null;
    try { fh = await memDir.getFileHandle(MEMFILE_NAME); } catch (e) { if (e.name !== 'NotFoundError' && e.name !== 'TypeMismatchError') throw e; }
    if (!fh) memBlocked = false; // 檔案不見了（例如被刪除）：重新建立
    const st = memState(), today = taiwanDay();
    if (fh && pull) {
      const file = await fh.getFile();
      if (file.lastModified !== st.mtime || file.size !== st.size) {
        let rows;
        try { rows = parseMemoryText(memDecode(await file.arrayBuffer())); }
        catch (e) { memBlocked = true; memNote = `資料夾「${memDir.name}」的 列印記憶.txt ${e.message} 未套用，也不會被覆蓋；請修正後存檔。目前使用瀏覽器內的記憶。`; memRender(); return { ...res, error: true }; }
        memSaveRows(rows); memBlocked = false; res.pulled = true; write = true;
        memNote = `已套用 列印記憶.txt 的修改（${memStamp()}）。`;
        if (typeof updateMemoryStatus === 'function') updateMemoryStatus();
        if (typeof render === 'function') render();
      }
    }
    if (st.day !== today) write = true; // 每天第一次同步：更新檔頭的比對日、清除過期紀錄
    if ((!fh || write) && (!memBlocked || force)) {
      fh = fh || await memDir.getFileHandle(MEMFILE_NAME, { create: true });
      const w = await fh.createWritable();
      await w.write(new Blob(['﻿' + memoryText()], { type: 'text/plain' })); await w.close();
      const f = await fh.getFile(); memSetState({ mtime: f.lastModified, size: f.size, day: today, at: Date.now() });
      memBlocked = false; res.wrote = true;
      if (!res.pulled) memNote = '';
    }
  } finally { memInSync = false; }
  memRender(); return res;
}
// history.js 改寫記憶時（例如清除過期紀錄）呼叫
function memoryFileChanged() { if (memDir && !memInSync) memorySync({ write: true }); }

// ---------- 畫面 ----------
function memRender() {
  const status = $('memFileStatus'), link = $('memLinkBtn'), unlink = $('memUnlinkBtn');
  if (!status) return;
  const st = memState();
  let text;
  if (!memSupported) text = '此瀏覽器不支援直接寫入資料夾；可用「下載 TXT」手動保存。';
  else if (!memDir) text = '尚未設定 TXT 存放資料夾：目前記憶只存在 Chrome 內部。設定後每次記錄列印都會自動更新「列印記憶.txt」，可用記事本開啟查看。';
  else if (memPerm !== 'granted') text = `已連結資料夾「${memDir.name}」，需要允許才能更新 列印記憶.txt：按「允許並同步」，或下次按列印時允許（Chrome 詢問時建議選「每次造訪都允許」）。`;
  else text = `自動同步到資料夾「${memDir.name}」→ ${MEMFILE_NAME}${st.at ? `（最後寫入 ${memStamp(st.at)}）` : ''}。`;
  status.textContent = text + (memNote ? ' ' + memNote : '');
  status.classList.toggle('mem-warn', memBlocked || (!!memDir && memPerm !== 'granted'));
  link.hidden = !memSupported;
  link.textContent = !memDir ? '設定 TXT 存放資料夾' : memPerm !== 'granted' ? '允許並同步' : '變更資料夾';
  unlink.hidden = !memDir;
}
async function memLink() {
  if (memDir && memPerm !== 'granted') { await memorySync({ gesture: true }); return; } // 已連結：只需重新允許
  $('memPickDialog').showModal(); // 先說明步驟，按「選擇資料夾」才開啟 Chrome 的選擇視窗
}
async function memPick() {
  $('memPickDialog').close();
  let dir;
  try { dir = await window.showDirectoryPicker({ id: 'cart-label-memory', mode: 'readwrite' }); }
  catch (e) {
    memNote = e.name === 'AbortError' ? '未選擇資料夾。若出現「資料夾中包含系統檔案」，請先「新增資料夾」建立專用資料夾（例如「藥車標籤列印記憶」）再選它，不要直接選「文件」「下載」「桌面」或磁碟最上層（例如 D:\\）。' : '無法使用此資料夾：' + e.message;
    memRender(); return;
  }
  // 資料夾內已有 列印記憶.txt（例如重新安裝後）：與瀏覽器內的記憶合併
  let fileRows = [];
  try { const fh = await dir.getFileHandle(MEMFILE_NAME); fileRows = parseMemoryText(memDecode(await (await fh.getFile()).arrayBuffer())); }
  catch (e) { if (e.name !== 'NotFoundError') { memNote = `資料夾「${dir.name}」內的 列印記憶.txt ${e.message} 請修正或刪除該檔後再選一次。`; memRender(); return; } }
  const merged = new Map([...fileRows, ...memStoredRows()].map(r => [memRowKey(r), r]));
  memSaveRows([...merged.values()]);
  memDir = dir; memPerm = 'granted'; memBlocked = false; memSetState(null);
  try { await memIdb('put', dir); } catch {}
  const r = await memorySync({ write: true, pull: false, force: true });
  if (r.wrote) memNote = fileRows.length ? `已與資料夾內原有的 列印記憶.txt 合併。` : `已建立 ${MEMFILE_NAME}。`;
  updateMemoryStatus(); if (typeof render === 'function') render(); memRender();
}
async function memUnlink() {
  try { await memIdb('delete'); } catch {}
  const name = memDir?.name; memDir = null; memPerm = 'none'; memBlocked = false; memSetState(null);
  memNote = name ? `已取消連結「${name}」；資料夾中的 ${MEMFILE_NAME} 仍保留，不需要可自行刪除。` : ''; memRender();
}
let memImportRows = null;
async function memImportPicked() {
  const file = $('memImportFile').files[0]; if (!file) return;
  try {
    if (file.size > 2000000) throw Error('檔案過大（超過 2 MB）。');
    const rows = parseMemoryText(memDecode(await file.arrayBuffer())), kept = retainedHistory(rows);
    const days = new Set(kept.map(r => r.day)).size, pts = kept.filter(r => r.account).length;
    memImportRows = kept;
    $('memImportSummary').textContent = `「${file.name}」：${days} 個列印日、病人 ${pts} 筆、空床 ${kept.length - pts} 床${rows.length - kept.length ? `（另有 ${rows.length - kept.length} 筆超過 ${KEEP_DAYS} 天或日期在未來，不匯入）` : ''}。`;
    $('memImportDialog').showModal();
  } catch (e) { $('status').textContent = '匯入列印記憶失敗：' + e.message; memNote = '匯入失敗：' + e.message; memRender(); }
  finally { $('memImportFile').value = ''; }
}
async function memImportApply(mode) {
  const rows = memImportRows; memImportRows = null; $('memImportDialog').close();
  if (!rows || printBusy) return;
  try {
    const next = mode === 'merge' ? [...new Map([...memStoredRows(), ...rows].map(r => [memRowKey(r), r])).values()] : rows;
    memSaveRows(next); updateMemoryStatus(); if (typeof render === 'function') render();
    const r = await memorySync({ write: true, pull: false, force: true, gesture: true });
    $('status').textContent = `已${mode === 'merge' ? '合併' : '取代'}匯入列印記憶。${r.wrote ? ' 已更新 列印記憶.txt。' : ''}`;
  } catch { $('status').textContent = '此瀏覽器無法儲存列印記憶。'; }
}

// ---------- 初始化 ----------
(async () => {
  document.querySelectorAll('a[href="memory.html"]').forEach(a => a.addEventListener('click', memSnapshot));
  $('memDownloadBtn').onclick = () => downloadPresetText(memoryText(), MEMFILE_NAME);
  $('memLinkBtn').onclick = memLink; $('memUnlinkBtn').onclick = memUnlink;
  $('memPickGo').onclick = memPick; $('memPickCancel').onclick = () => $('memPickDialog').close();
  $('memImportBtn').onclick = () => $('memImportFile').click(); $('memImportFile').onchange = memImportPicked;
  $('memImportCancel').onclick = () => { memImportRows = null; $('memImportDialog').close(); };
  $('memImportMerge').onclick = () => memImportApply('merge'); $('memImportReplace').onclick = () => memImportApply('replace');
  if (memSupported) { try { memDir = (await memIdb('get')) || null; } catch {} }
  memRender(); memSnapshot();
  if (memDir) await memorySync({});
})();
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && memDir) memorySync({}); });

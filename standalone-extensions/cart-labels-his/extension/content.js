// HIS 頁面：偵測病人清單，顯示「藥車標籤」浮動按鈕；可選擇攔截院內原有的列印按鈕。
// v1.6：頁面掃描預設關閉。v1.5：院內「列印病人標籤」直接轉成藥車標籤（含病歷號、生日），移除攔截設定。v1.4：有勾選病人時只送勾選的病人。v1.3：擴充功能更新後舊腳本自動退場。v1.1：document_start 先註冊點擊攔截（早於院內程式）、按下立即回饋、錯誤顯示在按鈕上與 Console。
(() => {
  'use strict';
  if (window.__cartLabelLoaded) return;
  window.__cartLabelLoaded = true;

  const TAG = '[藥車標籤]';
  const ACCOUNT = /(^|[\s\t])[0-9]{2}[A-Za-z][0-9]{6,}(?=[\s\t]|$)/m;
  let btn = null;
  let flashing = false;
  let busy = false;
  const listeners = [];
  const on = (type, fn) => { window.addEventListener(type, fn, true); listeners.push([type, fn]); };
  // 擴充功能重新載入後，舊腳本會失效（chrome.runtime 消失）。失效時自動退場，不攔截任何點擊。
  function alive() { try { return !!chrome.runtime?.id; } catch { return false; } }
  function retire() {
    listeners.forEach(([t, fn]) => window.removeEventListener(t, fn, true));
    btn?.remove(); btn = null;
    console.warn(TAG, '擴充功能已更新，舊版腳本已停用；請按 F5 重新整理此頁');
  }

  // 病人清單表格中有勾選時，只送勾選的病人（含標題列）
  function checkedText() {
    const out = [];
    for (const table of document.querySelectorAll('table')) {
      const rows = [...table.rows].filter(tr => !tr.querySelector('table'));
      const header = rows.find(tr => ['帳號', '病房', '病室', '病床', '姓名'].every(f => [...tr.cells].some(c => c.innerText.trim() === f)));
      if (!header) continue;
      const picked = rows.filter(tr => tr !== header && tr.querySelector('input[type=checkbox]:checked'));
      if (!picked.length) continue;
      const line = tr => [...tr.cells].map(c => c.innerText.replace(/\s+/g, ' ').trim()).join('\t');
      out.push(line(header), ...picked.map(line));
    }
    return out.length ? out.join('\n') : '';
  }

  function pageText() {
    const checked = checkedText();
    if (checked) return { text: checked, partial: '勾選' };
    const sel = String(window.getSelection() || '');
    if (sel && ACCOUNT.test(sel)) return { text: sel, partial: '選取範圍' };
    return { text: document.body ? document.body.innerText : '', partial: false };
  }
  function countPatients(text) {
    return text.split('\n').filter(l => ACCOUNT.test(l)).length;
  }

  function send(source) {
    if (busy) return;
    if (!alive()) { retire(); alert('藥車標籤擴充功能已更新，請按 F5 重新整理此頁後再試。'); return; }
    console.log(TAG, '觸發：', source);
    const { text, partial } = pageText();
    const n = countPatients(text);
    if (!n) { flash('此頁沒有找到病人清單', 3000); console.warn(TAG, '找不到帳號格式的資料列'); return; }
    openTool(text, `${n} 筆${partial ? '（' + partial + '）' : '（全部）'}`);
  }

  function openTool(text, desc) {
    if (busy) return;
    busy = true;
    flash('開啟中…', 10000);
    const fail = msg => { busy = false; flash(msg, 6000); console.error(TAG, msg); };
    const timer = setTimeout(() => fail('擴充功能沒有回應：請到 chrome://extensions 重新載入，再按 F5'), 4000);
    try {
      chrome.runtime.sendMessage({ type: 'open-labels', text }, res => {
        clearTimeout(timer);
        const err = chrome.runtime.lastError;
        if (err || !res?.ok) return fail('開啟失敗：' + (err?.message || res?.error || '未知錯誤'));
        busy = false;
        flash('已送出 ' + desc, 2500);
      });
    } catch (e) {
      clearTimeout(timer);
      fail(/context invalidated/i.test(e.message) ? '擴充功能已更新，請按 F5 重新整理此頁' : '錯誤：' + e.message);
    }
  }

  function flash(msg, ms) {
    console.log(TAG, msg);
    if (!btn) return;
    flashing = true;
    btn.textContent = msg;
    clearTimeout(flash.t);
    flash.t = setTimeout(() => { flashing = false; if (btn) btn.textContent = btn.dataset.label; }, ms);
  }

  function ensureButton(n) {
    if (!n) { btn?.remove(); btn = null; return; }
    if (!btn || !btn.isConnected) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.id = '__cartLabelBtn';
      btn.title = '將病人清單轉成藥車標籤：有勾選只帶勾選的病人；否則有反白只帶反白範圍；都沒有則帶全部';
      btn.style.cssText = 'position:fixed;right:16px;bottom:64px;z-index:2147483647;padding:8px 14px;' +
        'border:0;border-radius:8px;background:#c15f3c;color:#fff;font:bold 14px "Microsoft JhengHei",sans-serif;' +
        'box-shadow:0 2px 8px rgba(0,0,0,.3);cursor:pointer;max-width:360px;text-align:left;';
      (document.body || document.documentElement).appendChild(btn);
    }
    btn.dataset.label = `▤ 藥車標籤（${n} 位）`;
    if (!flashing && btn.textContent !== btn.dataset.label) btn.textContent = btn.dataset.label;
  }

  // 在 window 捕獲階段處理所有點擊，避免院內程式先攔掉事件
  const isOurs = e => btn && e.composedPath().includes(btn);
  on('mousedown', e => {
    if (!alive()) return retire();
    if (isOurs(e)) { e.preventDefault(); e.stopImmediatePropagation(); }
  });
  on('click', e => {
    if (!alive()) return retire();
    if (isOurs(e)) { e.preventDefault(); e.stopImmediatePropagation(); send('浮動按鈕'); }
  });

  try { chrome.storage.local.remove('interceptText'); } catch {}

  // 從頁面病人清單讀取「MM/DD可出院」，以 病房|病室|病床 對應（院內列印資料本身沒有出院資訊）
  const bedId = (w, r, b) => [w, r, b].map(v => String(v || '').trim().toUpperCase().replace(/^0+(?=\d)/, '')).join('|');
  function dischargeNotes() {
    const map = new Map();
    for (const table of document.querySelectorAll('table')) {
      const rows = [...table.rows].filter(tr => !tr.querySelector('table'));
      const header = rows.find(tr => ['病房', '病室', '病床'].every(f => [...tr.cells].some(c => c.innerText.trim() === f)));
      if (!header) continue;
      const names = [...header.cells].map(c => c.innerText.trim());
      const [iw, ir, ib] = ['病房', '病室', '病床'].map(f => names.indexOf(f));
      for (const tr of rows) {
        if (tr === header) continue;
        const cells = [...tr.cells].map(c => c.innerText.replace(/\s+/g, ' ').trim());
        const note = cells.map(c => c.match(/\d{1,2}\/\d{1,2}\s*可出院/)).find(Boolean);
        if (note) map.set(bedId(cells[iw], cells[ir], cells[ib]), note[0]);
      }
    }
    return map;
  }

  // 院內列印資料的姓名可能被截斷（英文長姓名）：用頁面病人清單同一床的完整姓名補齊
  const normName = v => String(v || '').replace(/[.…]+$/, '').replace(/\s+/g, '').toUpperCase();
  function pageNames() {
    const map = new Map();
    for (const table of document.querySelectorAll('table')) {
      const rows = [...table.rows].filter(tr => !tr.querySelector('table'));
      const header = rows.find(tr => ['病房', '病室', '病床', '姓名'].every(f => [...tr.cells].some(c => c.innerText.trim() === f)));
      if (!header) continue;
      const names = [...header.cells].map(c => c.innerText.trim());
      const [iw, ir, ib, iname] = ['病房', '病室', '病床', '姓名'].map(f => names.indexOf(f));
      for (const tr of rows) {
        if (tr === header || tr.cells.length < names.length) continue;
        const cell = tr.cells[iname];
        const texts = [cell.innerText, cell.title, ...[...cell.querySelectorAll('[title]')].map(e => e.title)].map(t => String(t || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
        const full = texts.sort((a, b) => b.length - a.length)[0];
        if (full) map.set(bedId(tr.cells[iw].innerText, tr.cells[ir].innerText, tr.cells[ib].innerText), full);
      }
    }
    return map;
  }
  function completeNames(patients) {
    const map = pageNames();
    let fixed = 0;
    const out = patients.map(p => {
      const full = map.get(bedId(p.ward, p.room, p.bed));
      const a = normName(p.name), b = normName(full);
      // 頁面姓名較長，且包含院內列印的那一段（前段或後段）才補齊；不同人不改
      if (full && full !== p.name && b.length >= a.length && a && b.includes(a)) { fixed++; return { ...p, name: full }; } // 同名不同空格時也以頁面寫法為準
      return p;
    });
    if (fixed) console.log(TAG, `已用頁面清單補齊 ${fixed} 位病人的完整姓名`);
    return out;
  }

  // 院內「列印病人標籤」：hook.js 解析出病歷號與生日後，轉送到標籤工具
  function buildText(patients) {
    const clean = v => String(v || '').replace(/[\t\n]/g, ' ');
    const notes = dischargeNotes();
    return ['#院內列印資料\t病房\t病室\t病床\t姓名\t病歷號\t生日\t出院',
      ...patients.map(p => [p.ward, p.room, p.bed, p.name, p.chart, p.birthday, notes.get(bedId(p.ward, p.room, p.bed)) || ''].map(clean).join('\t'))].join('\n');
  }
  window.__cartLabelBuildText = buildText; // 供 auto.js 使用
  document.addEventListener('cartlabel-capture', e => {
    if (!alive()) return retire();
    let patients = [];
    try { patients = JSON.parse(e.detail); } catch { return; }
    try { patients = completeNames(patients); } catch (err) { console.warn(TAG, '補齊姓名失敗', err); }
    if (window.__cartLabelAuto?.active) { window.__cartLabelAuto.onCapture(patients); return; } // 自動抓取中：交給 auto.js
    if (!patients.length) { console.warn(TAG, '院內列印資料中沒有讀到病人'); return; }
    openTool(buildText(patients), `院內列印 ${patients.length} 位`);
  });

  let timer = 0;
  function refresh() {
    clearTimeout(timer);
    timer = setTimeout(() => alive() ? ensureButton(document.body ? countPatients(document.body.innerText) : 0) : retire(), 400);
  }
  // 頁面掃描（右下角帳號版按鈕）：預設關閉，可在擴充功能選單開啟
  let observer = null;
  function setScan(on) {
    if (on && !observer) {
      observer = new MutationObserver(refresh);
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      refresh();
    } else if (!on && observer) {
      observer.disconnect(); observer = null;
      clearTimeout(timer);
      btn?.remove(); btn = null;
    }
  }
  function start() {
    try {
      chrome.storage.local.get('pageScan').then(v => setScan(v.pageScan === true));
      chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && c.pageScan) setScan(c.pageScan.newValue === true); });
    } catch (e) { console.warn(TAG, e); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();

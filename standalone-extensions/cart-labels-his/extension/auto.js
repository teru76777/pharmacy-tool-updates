// HIS 查詢處理頁面：依設定的病房自動「查詢 → 勾選全部 → 列印病人標籤」，接住資料後送到藥車標籤工具。
// 院內列印元件在 Chrome 無法實際列印（已由 hook.js 接手），所以這個流程不會印出院內標籤。
(() => {
  'use strict';
  if (window.__cartLabelAutoLoaded) return;
  window.__cartLabelAutoLoaded = true;
  const TAG = '[藥車標籤][自動]';
  const $q = sel => document.querySelector(sel);
  const wardInput = () => $q('[id$="QueryInPatientByBedBox_txbWardCode"]');
  const roomInput = () => $q('[id$="QueryInPatientByBedBox_txbRoomCode"]');
  const bedInput = () => $q('[id$="QueryInPatientByBedBox_txbBedNo"]');
  const queryBtn = () => $q('[id$="QueryInPatientByBedBox_btnQueryInBed"]');
  const printBtn = () => [...document.querySelectorAll('input[type=button],input[type=submit],button,a')]
    .find(el => /列印病人標籤/.test(el.value || el.textContent || ''));
  const norm = v => String(v || '').trim().toUpperCase().replace(/^0+(?=\d)/, '');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };

  let endCount = 0;
  document.addEventListener('cartlabel-endrequest', () => { endCount++; register(); });
  async function waitUntil(cond, timeout, what) {
    const t0 = Date.now();
    while (!cond()) {
      if (state.stop) throw new Error('已停止');
      if (Date.now() - t0 > timeout) throw new Error(what + '逾時');
      await sleep(200);
    }
  }

  // ---------- 讀取病人清單 ----------
  function patientRows() {
    for (const table of document.querySelectorAll('table')) {
      const rows = [...table.rows].filter(tr => !tr.querySelector('table'));
      const header = rows.find(tr => ['帳號', '病房', '病室', '病床', '姓名'].every(f => [...tr.cells].some(c => c.innerText.trim() === f)));
      if (!header) continue;
      const names = [...header.cells].map(c => c.innerText.trim());
      const [iw, ir, ib] = ['病房', '病室', '病床'].map(f => names.indexOf(f));
      return rows.filter(tr => tr !== header).map(tr => {
        const cb = tr.querySelector('input[type=checkbox]');
        const cells = [...tr.cells].map(c => c.innerText.trim());
        return cb ? { cb, ward: cells[iw], key: [cells[iw], cells[ir], cells[ib]].map(norm).join('|') } : null;
      }).filter(Boolean);
    }
    return [];
  }

  // ---------- 單一步驟 ----------
  async function queryWard(ward) {
    const input = wardInput(), btn = queryBtn();
    if (!input || !btn) throw new Error('找不到「病房」查詢欄位，請停在查詢處理頁面');
    input.focus();
    input.value = ward;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    if (roomInput()) roomInput().value = '';
    if (bedInput()) bedInput().value = '';
    const start = endCount, t0 = Date.now();
    btn.click();
    await waitUntil(() => endCount > start || (Date.now() - t0 > 2000 && queryBtn() && !queryBtn().disabled && queryBtn().value !== '處理中...'), 30000, '查詢');
    await sleep(400);
    const rows = patientRows();
    if (rows.length && !rows.every(r => norm(r.ward) === norm(ward))) throw new Error(`查詢結果不是 ${ward} 病房`);
    return rows;
  }

  let captureWaiter = null;
  // content.js 接到院內列印資料時呼叫
  window.__cartLabelAuto = {
    get active() { return state.running; },
    onCapture(patients) { if (captureWaiter) { captureWaiter(patients); captureWaiter = null; } }
  };
  async function printSelected(rows, selectedKeys) {
    for (const r of rows) {
      const want = selectedKeys.has(r.key);
      if (r.cb.checked !== want) { r.cb.checked = want; r.cb.dispatchEvent(new Event('change', { bubbles: true })); }
    }
    const btn = printBtn();
    if (!btn) throw new Error('找不到「列印病人標籤」按鈕');
    const got = new Promise((resolve, reject) => {
      captureWaiter = resolve;
      setTimeout(() => { if (captureWaiter === resolve) { captureWaiter = null; reject(new Error('等待院內列印資料逾時')); } }, 30000);
    });
    btn.click();
    const patients = await got;
    await sleep(500);
    return patients;
  }

  async function collectWard(ward) {
    let rows = await queryWard(ward);
    if (!rows.length) return { patients: [], total: 0 };
    const total = rows.length;
    const remaining = new Set(rows.map(r => r.key));
    const byChart = new Map();
    let chunk = rows.length, guard = 0;
    while (remaining.size && guard++ < 40) {
      if (state.stop) throw new Error('已停止');
      rows = patientRows();
      const pick = new Set(rows.filter(r => remaining.has(r.key)).slice(0, chunk).map(r => r.key));
      if (!pick.size) break;
      update(ward, `擷取中（${total - remaining.size}/${total}）`);
      const patients = await printSelected(rows, pick);
      if (!patients.length) break; // 這批讀不到（例如資料格式特殊的病人）：其餘照常，列為未擷取
      for (const p of patients) {
        byChart.set(p.chart + '|' + p.ward + p.room + p.bed, p);
        remaining.delete([p.ward, p.room, p.bed].map(norm).join('|'));
      }
      if (patients.length < pick.size) chunk = Math.max(1, patients.length); // 院內一次可印數量有上限時，改為分批
    }
    for (const r of patientRows()) if (r.cb.checked) { r.cb.checked = false; r.cb.dispatchEvent(new Event('change', { bubbles: true })); }
    const missingBeds = [...remaining].map(k => k.split('|').slice(1).join('-'));
    return { patients: [...byChart.values()], total, missing: remaining.size, missingBeds };
  }

  // ---------- 主流程 ----------
  const state = { running: false, stop: false };
  async function runOriginal(wards) {
    if (state.running) return;
    if (!wards?.length) { alert('尚未設定要自動抓取的病房：請按工具列的藥車標籤擴充功能按鈕設定組合。'); return; }
    if (!alive()) { alert('藥車標籤擴充功能已更新，請按 F5 重新整理此頁後再試。'); return; }
    state.running = true; state.stop = false;
    await window.__cartLabelArm?.('自動抓取'); // 啟用攔截（院內列印、查詢完成通知）
    const batch = 'auto-' + Date.now();
    const summary = [];
    showPanel(wards);
    try {
      for (const [i, ward] of wards.entries()) {
        if (state.stop) { summary.push({ ward, error: '已停止' }); update(ward, '已停止', 'err'); continue; }
        update(ward, '查詢中…');
        try {
          const res = await collectWard(ward);
          const text = window.__cartLabelBuildText(res.patients);
          await send({ text: res.patients.length ? text : '', batch: { id: batch, reset: i === 0, last: false } });
          const note = res.missing ? `，${res.missing} 位未擷取（${res.missingBeds.join('、')}）` : '';
          summary.push({ ward, count: res.patients.length, total: res.total, missing: res.missing || 0, missingBeds: res.missingBeds || [] });
          update(ward, res.total ? `✓ ${res.patients.length} 位${note}` : '✓ 無病人', res.missing ? 'warn' : 'ok');
        } catch (e) {
          console.warn(TAG, ward, e);
          summary.push({ ward, error: e.message });
          update(ward, '✕ ' + e.message, 'err');
          if (i === 0) await send({ text: '', batch: { id: batch, reset: true, last: false } });
        }
      }
      await send({ text: '', batch: { id: batch, last: true, summary } });
      panelDone(summary);
    } catch (e) {
      panelDone(summary, e.message);
    } finally {
      state.running = false;
    }
  }
  async function run(wards){
    let lease;
    const request=async(action,extra={})=>{const r=await chrome.runtime.sendMessage({kind:'managed-tool',action,...extra});if(!r?.ok)throw Error(r?.error||'管理驗證失敗');return r.data;};
    try{lease=await request('acquire');await runOriginal(wards);}
    catch(e){alert(e.message);}
    finally{if(lease)await request('release',{token:lease.token}).catch(()=>{});}
  }
  function send(msg) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type: 'open-labels', ...msg }, res => {
          const err = chrome.runtime.lastError;
          if (err || !res?.ok) reject(new Error('無法送到標籤工具：' + (err?.message || res?.error || '')));
          else resolve();
        });
      } catch (e) { reject(e); }
    });
  }

  // ---------- 進度面板 ----------
  let panel = null;
  const css = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;width:300px;background:#fff;border:1px solid #d8d4c9;border-radius:10px;' +
    'box-shadow:0 6px 24px rgba(0,0,0,.25);font:14px "Microsoft JhengHei",sans-serif;color:#1f1e1d;padding:12px 14px;';
  function showPanel(wards) {
    panel?.remove();
    panel = document.createElement('div');
    panel.style.cssText = css;
    panel.innerHTML = '<div style="font-weight:bold;margin-bottom:8px;color:#c15f3c">▤ 自動抓取藥車標籤</div><div data-list></div>' +
      '<div data-foot style="margin-top:10px;display:flex;justify-content:space-between;align-items:center;gap:8px"><span data-msg style="font-size:12px;color:#6b6963">請勿操作此頁面</span>' +
      '<button data-stop style="padding:5px 12px;border:1px solid #d8d4c9;border-radius:6px;background:#fff;cursor:pointer">停止</button></div>';
    const list = panel.querySelector('[data-list]');
    for (const w of wards) {
      const row = document.createElement('div');
      row.dataset.ward = w;
      row.style.cssText = 'display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid #f0eee7';
      row.innerHTML = '<b></b><span style="font-size:13px;color:#87857d">等待</span>';
      row.querySelector('b').textContent = w;
      list.append(row);
    }
    panel.querySelector('[data-stop]').onclick = () => { state.stop = true; panel.querySelector('[data-msg]').textContent = '停止中…'; };
    document.documentElement.append(panel);
  }
  function update(ward, text, kind) {
    const span = panel?.querySelector(`[data-ward="${CSS.escape(ward)}"] span`);
    if (!span) return;
    span.textContent = text;
    span.style.color = kind === 'ok' ? '#1d7a3a' : kind === 'err' ? '#b32929' : kind === 'warn' ? '#a35a00' : '#c15f3c';
  }
  function panelDone(summary, error) {
    if (!panel) return;
    const n = summary.reduce((s, r) => s + (r.count || 0), 0);
    panel.querySelector('[data-msg]').textContent = error ? '中斷：' + error : `完成，共 ${n} 位，已送到標籤工具`;
    const b = panel.querySelector('[data-stop]');
    b.textContent = '關閉';
    b.onclick = () => { panel.remove(); panel = null; };
  }

  // ---------- 註冊（由擴充功能按鈕的「組合」啟動） ----------
  function register() {
    if (!wardInput() || !alive()) return;
    try { chrome.runtime.sendMessage({ type: 'his-frame' }).catch(() => {}); } catch {}
  }
  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg?.type !== 'auto-run') return;
      if (!wardInput()) return sendResponse({ ok: false, error: '此頁不是查詢處理頁面' });
      sendResponse({ ok: true });
      run(msg.wards || []);
    });
  } catch {}
  const init = () => register();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();

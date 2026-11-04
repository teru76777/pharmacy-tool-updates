// 擴充功能按鈕：自動抓取組合（組合1、組合2）的設定與執行
const KEY = 'autoCombos';
const DEFAULTS = [{ name: '組合1', wards: [] }, { name: '組合2', wards: [] }];
const scan = document.getElementById('scan');

function parseWards(text) {
  const seen = new Set();
  return String(text || '').toUpperCase().split(/[\s,，、;；]+/).map(w => w.trim())
    .filter(w => /^[A-Z0-9]{1,4}$/.test(w) && !seen.has(w) && seen.add(w));
}
// 標籤工具（同一個擴充功能來源）的預設床位設定
function presetWards() {
  try {
    const saved = JSON.parse(localStorage.getItem('cart-label-bed-presets-v1') || 'null');
    if (!saved?.text) return [];
    const selected = new Set((saved.selected || []).map(s => String(s).toUpperCase()));
    return [...saved.text.matchAll(/\[([^\[\]]+)\]/g)].map(m => m[1].trim().toUpperCase()).filter(w => selected.has(w));
  } catch { return []; }
}

let combos = DEFAULTS;
const save = () => chrome.storage.local.set({ [KEY]: combos });

function render() {
  const box = document.getElementById('combos');
  box.replaceChildren();
  combos.forEach((combo, i) => {
    const node = document.getElementById('comboTpl').content.firstElementChild.cloneNode(true);
    const name = node.querySelector('.name'), wards = node.querySelector('.wards'), run = node.querySelector('.run'), msg = node.querySelector('.msg');
    name.value = combo.name;
    wards.value = combo.wards.join(' ');
    const refresh = () => {
      run.disabled = !combo.wards.length;
      run.textContent = combo.wards.length ? `▶ 執行 ${combo.name}（${combo.wards.length} 個病房）` : '▶ 執行（請先輸入病房）';
    };
    name.addEventListener('change', () => { combo.name = name.value.trim() || `組合${i + 1}`; name.value = combo.name; save(); refresh(); });
    wards.addEventListener('input', () => { combo.wards = parseWards(wards.value); refresh(); });
    wards.addEventListener('change', () => { combo.wards = parseWards(wards.value); wards.value = combo.wards.join(' '); save(); refresh(); });
    node.querySelector('.from-presets').onclick = () => {
      const list = presetWards();
      if (!list.length) { msg.className = 'msg err'; msg.textContent = '標籤工具的預設床位尚未勾選病房。'; return; }
      combo.wards = list; wards.value = list.join(' '); save(); refresh();
      msg.className = 'msg ok'; msg.textContent = '已帶入：' + list.join('、');
    };
    run.onclick = async () => {
      combo.wards = parseWards(wards.value); save(); refresh();
      if (!combo.wards.length) return;
      run.disabled = true; msg.className = 'msg'; msg.textContent = '開始中…';
      try {
        const res = await chrome.runtime.sendMessage({ type: 'start-auto', wards: combo.wards });
        if (!res?.ok) throw new Error(res?.error || '沒有回應');
        msg.className = 'msg ok'; msg.textContent = '已在 HIS 頁面開始執行。';
        setTimeout(() => window.close(), 800);
      } catch (e) {
        msg.className = 'msg err'; msg.textContent = e.message;
        run.disabled = false;
      }
    };
    refresh();
    box.append(node);
  });
}

chrome.storage.local.get([KEY, 'autoWards', 'pageScan']).then(v => {
  if (Array.isArray(v[KEY]) && v[KEY].length) combos = v[KEY].map((c, i) => ({ name: c.name || `組合${i + 1}`, wards: Array.isArray(c.wards) ? c.wards : [] }));
  else {
    combos = DEFAULTS.map(c => ({ ...c, wards: [] }));
    if (Array.isArray(v.autoWards) && v.autoWards.length) combos[0].wards = v.autoWards; // 舊版設定搬到組合1
    save();
  }
  while (combos.length < 2) combos.push({ name: `組合${combos.length + 1}`, wards: [] });
  render();
  scan.checked = v.pageScan === true;
});
scan.onchange = () => chrome.storage.local.set({ pageScan: scan.checked });
document.getElementById('open').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('labels/index.html') });
document.getElementById('openMem').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('labels/memory.html') });

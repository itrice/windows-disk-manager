
'use strict';

/* ============================== helpers ============================== */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

function fmtBytes(n) {
  if (n == null || Number.isNaN(n)) return '0 B';
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n, u = -1;
  do { v /= 1024; u++; } while (v >= 1024 && u < units.length - 1);
  return v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2) + ' ' + units[u];
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtDur(ms) {
  if (ms == null) return '';
  return ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(1) + ' s';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(path, opts) {
  const res = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

function toast(msg, kind) {
  const el = document.createElement('div');
  el.className = 'toast ' + (kind || '');
  el.textContent = msg;
  $('#toastRoot').appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

function emptyState(msg) {
  return '<div class="empty-state">' + escapeHtml(msg || 'Nothing here yet.') + '</div>';
}

/* ============================== state ============================== */
const state = {
  status: null,
  report: null,
  config: null,
  tab: 'drafts',
  selection: new Map(),              // path -> size
  sort: 'size', order: 'desc',       // client-side sorting for embedded lists
  q: '',                             // client-side search
  allPage: { offset: 0, limit: 100, total: 0, q: '', sort: 'size', order: 'desc', items: [] },
  polling: null,
  searchTimer: null,
  rules: {},                         // ruleId -> label
};

const CAT_CLASS = { draft: 'draft', temp: 'temp', backup: 'backup', partial: 'partial', junk: 'junk' };
const PALETTE = ['#4c9aff', '#6ee7b7', '#fbbf24', '#a78bfa', '#f87171', '#34d399', '#60a5fa', '#f472b6', '#94a3b8', '#2dd4bf', '#fb923c', '#818cf8', '#4ade80', '#e879f9', '#38bdf8', '#facc15', '#a3e635', '#fda4af', '#7dd3fc', '#c4b5fd'];

/* ============================== init ============================== */
async function init() {
  bindEvents();
  try {
    const [st, cfg] = await Promise.all([api('/api/status'), api('/api/config')]);
    state.status = st.status;
    state.config = cfg.config;
    if (cfg.config.root) $('#rootInput').value = cfg.config.root;
    if (Array.isArray(cfg.config.draftPatterns)) {
      for (const r of cfg.config.draftPatterns) state.rules[r.id] = r.label;
    }
    renderStatus();
    if (state.status.state === 'done') await loadReport();
  } catch (e) {
    toast(e.message || 'Cannot reach server', 'err');
    renderStatus();
  }
}

/* ============================== status / scan ============================== */
function renderStatus() {
  const s = state.status || { state: 'idle' };
  const badge = $('#statusBadge');
  const map = {
    idle: ['Idle', 'idle'], scanning: ['Scanning…', 'scanning'],
    done: ['Scan complete', 'done'], error: ['Error', 'error'], cancelled: ['Cancelled', 'cancelled'],
  };
  const [label, cls] = map[s.state] || [s.state, 'idle'];
  badge.textContent = label;
  badge.className = 'badge ' + cls;
  $('#btnCancel').classList.toggle('hidden', s.state !== 'scanning');
  $('#btnScan').disabled = s.state === 'scanning';
  if (s.state === 'scanning' && s.progress) {
    $('#progressWrap').classList.remove('hidden');
    $('#progressBar').classList.add('indet');
    const elapsed = Math.round((Date.now() - s.progress.startedAt) / 1000);
    $('#progressText').textContent = (s.progress.processedFiles || 0).toLocaleString() + ' files · ' + elapsed + 's · ' + (s.progress.currentPath || '');
  } else {
    $('#progressWrap').classList.add('hidden');
    $('#progressBar').classList.remove('indet');
  }
}

async function startScan() {
  const root = $('#rootInput').value.trim();
  try {
    await api('/api/scan', { method: 'POST', body: JSON.stringify({ root: root || null }) });
    state.status = { state: 'scanning', progress: { processedFiles: 0, currentPath: root, startedAt: Date.now() } };
    renderStatus();
    pollStatus();
    toast('Scan started' + (root ? ' for ' + root : ''), 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
}

function pollStatus() {
  clearInterval(state.polling);
  state.polling = setInterval(async () => {
    try {
      const d = await api('/api/status');
      state.status = d.status;
      renderStatus();
      if (d.status.state !== 'scanning') {
        clearInterval(state.polling);
        await loadReport();
      }
    } catch (_) { /* keep polling */ }
  }, 600);
}

/* ============================== report ============================== */
async function loadReport() {
  try {
    const d = await api('/api/report');
    state.report = d.report;
    renderStatus();
    renderCards();
    renderCharts();
    await renderTab();
  } catch (e) {
    toast(e.message, 'err');
  }
}

function renderCards() {
  const r = state.report;
  if (!r) return;
  const draftBytes = r.drafts.reduce((a, f) => a + f.size, 0);
  const oldCount = r.oldFiles.length;
  const cards = [
    { k: 'Total size', v: r.totals.bytesFormatted, s: r.meta.root },
    { k: 'Files / folders', v: r.totals.files.toLocaleString(), s: r.totals.dirs.toLocaleString() + ' folders (' + r.totals.ignoredDirs + ' ignored)' },
    { k: 'Drafts & junk found', v: r.drafts.length.toLocaleString(), s: fmtBytes(draftBytes) + ' reclaimable', hot: r.drafts.length > 0, danger: true },
    { k: 'Old files', v: oldCount.toLocaleString(), s: 'not modified in ' + r.meta.oldFileDays + ' days' },
    { k: 'Empty folders', v: r.emptyDirsTotal.toLocaleString(), s: 'safe to remove' },
    { k: 'Scan duration', v: fmtDur(r.meta.durationMs), s: new Date(r.meta.scannedAt).toLocaleString() },
  ];
  $('#cards').innerHTML = cards.map((c) =>
    '<div class="card' + (c.hot ? ' hot' : '') + '"><div class="k">' + c.k + '</div>' +
    '<div class="v' + (c.danger ? ' danger' : '') + '">' + c.v + '</div>' +
    '<div class="s">' + escapeHtml(c.s || '') + '</div></div>').join('');
  const t = $('#tabDraftCount');
  if (r.drafts.length) { t.textContent = r.drafts.length.toLocaleString(); t.classList.remove('hidden'); }
  else { t.textContent = ''; t.classList.add('hidden'); }
}

function renderCharts() {
  const r = state.report;
  if (!r) return;
  const tl = r.topLevel || [];
  const max = tl.length ? tl[0].size : 1;
  $('#topLevelChart').innerHTML = tl.length
    ? tl.slice(0, 15).map((d) =>
        '<div class="hbar"><div class="name" title="' + escapeHtml(d.path) + '">' + escapeHtml(d.name) + '</div>' +
        '<div class="track"><div class="fill" style="width:' + Math.max(1, (d.size / max) * 100).toFixed(1) + '%"></div></div>' +
        '<div class="size">' + d.sizeFormatted + '</div></div>').join('')
    : emptyState('Run a scan to see the folder breakdown.');

  const exts = r.extensions || [];
  const total = exts.reduce((a, e) => a + e.size, 0);
  const donut = $('#extDonut');
  if (!exts.length) {
    donut.style.background = '';
    $('#extLegend').innerHTML = emptyState('No files scanned yet.');
    return;
  }
  // conic-gradient is unavailable on some older engines (e.g. Edge legacy on Win7);
  // fall back to showing percentages in the legend.
  const supportsConic = typeof CSS !== 'undefined' && CSS.supports &&
    CSS.supports('background', 'conic-gradient(red, blue)');
  let acc = 0;
  const stops = [];
  for (let i = 0; i < exts.length; i++) {
    const pct = total ? (exts[i].size / total) * 100 : 0;
    stops.push(PALETTE[i % PALETTE.length] + ' ' + acc.toFixed(2) + '% ' + (acc + pct).toFixed(2) + '%');
    acc += pct;
  }
  if (supportsConic) {
    donut.style.background = 'conic-gradient(' + stops.join(', ') + ')';
  } else {
    donut.classList.add('no-conic');
    donut.style.background = '';
  }
  $('#extLegend').innerHTML = exts.map((e, i) => {
    const share = total ? Math.round((e.size / total) * 1000) / 10 : 0;
    return '<div class="row"><span class="sw" style="background:' + PALETTE[i % PALETTE.length] + '"></span>' +
      '<span class="ext">' + escapeHtml(e.ext) + '</span><span class="muted">' + e.count.toLocaleString() + '</span>' +
      '<span class="val">' + fmtBytes(e.size) + '</span>' +
      (supportsConic ? '' : '<span class="share muted">' + share + '%</span>') +
      '</div>';
  }).join('');
}

/* ============================== tabs ============================== */
const TABS = {
  drafts: renderDrafts,
  largest: renderLargest,
  old: renderOld,
  empty: renderEmpty,
  all: renderAll,
  activity: renderActivity,
  trash: renderTrash,
};

async function renderTab() {
  $$('#tabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  const fn = TABS[state.tab];
  try {
    await fn();
  } catch (e) {
    $('#tabToolbar').innerHTML = '';
    $('#tabBody').innerHTML = emptyState(e.message);
  }
}

/* --- table machinery --- */
function fileRow(f, opts) {
  const sel = state.selection.has(f.path);
  const badge = f.category
    ? '<span class="badge-cat ' + (CAT_CLASS[f.category] || 'junk') + '">' + escapeHtml(f.category) + '</span> '
    : '';
  const rule = f.ruleLabel ? '<span class="muted mono">' + escapeHtml(f.ruleLabel) + '</span>' : '';
  const cb = opts.selectable
    ? '<td><input type="checkbox" class="row-cb" data-path="' + escapeHtml(f.path) + '" data-size="' + Number(f.size) + '"' + (sel ? ' checked' : '') + '></td>'
    : '';
  return '<tr class="' + (sel ? 'row-selected' : '') + '">' + cb +
    '<td><span class="fname">' + escapeHtml(f.name) + '</span> ' + badge + (rule ? '<br>' + rule : '') + '</td>' +
    '<td class="num">' + f.sizeFormatted + '</td>' +
    '<td class="num muted">' + fmtDate(f.mtime) + '</td>' +
    '<td class="path" title="' + escapeHtml(f.path) + '">' + escapeHtml(f.path) + '</td></tr>';
}

function tableShell(rowsHtml, opts) {
  const selTh = opts.selectable ? '<th style="width:32px"><input type="checkbox" id="selectAllPage" title="Select all on this page"></th>' : '';
  return '<div class="table-wrap"><table><thead><tr>' + selTh +
    '<th class="sortable" data-sort="name">Name</th>' +
    '<th class="num sortable" data-sort="size">Size</th>' +
    '<th class="num sortable" data-sort="mtime">Modified</th>' +
    '<th>Path</th></tr></thead><tbody>' + rowsHtml + '</tbody></table></div>';
}

function sortList(list) {
  const s = state.sort, o = state.order === 'asc' ? 1 : -1;
  const copy = [...list];
  copy.sort((a, b) => {
    if (s === 'name') return a.name.localeCompare(b.name) * o;
    if (s === 'mtime') return (new Date(a.mtime) - new Date(b.mtime)) * o;
    return (Number(a.size) - Number(b.size)) * o;
  });
  return copy;
}

function dataTabToolbar(opts) {
  const selInfo = selectionInfoHtml();
  return '<input type="search" id="tabSearch" placeholder="Filter…" value="' + escapeHtml(state.q) + '">' +
    '<select id="tabSort"><option value="size"' + (state.sort === 'size' ? ' selected' : '') + '>Sort: size</option>' +
    '<option value="name"' + (state.sort === 'name' ? ' selected' : '') + '>Sort: name</option>' +
    '<option value="mtime"' + (state.sort === 'mtime' ? ' selected' : '') + '>Sort: modified</option></select>' +
    '<a class="btn small" href="/api/export?section=' + opts.section + '&format=csv">Export CSV</a>' +
    '<span class="spacer"></span>' + selInfo +
    '<button id="btnDeleteSel" class="btn danger small" disabled>Delete selected</button>';
}

function selectionInfoHtml() {
  const n = state.selection.size;
  let size = 0;
  state.selection.forEach((v) => { size += v || 0; });
  return '<span class="selection-info">Selected: <b>' + n + '</b> · <b>' + fmtBytes(size) + '</b></span>';
}

function refreshSelectionUI() {
  const info = selectionInfoHtml();
  const el = $('.selection-info');
  if (el) el.outerHTML = info;
  const btn = $('#btnDeleteSel');
  if (btn) btn.disabled = state.selection.size === 0;
  $$('tr.row-selected').forEach((tr) => tr.classList.remove('row-selected'));
  $$('.row-cb:checked').forEach((cb) => {
    const tr = cb.closest('tr');
    if (tr) tr.classList.add('row-selected');
  });
}

/* --- data tabs: drafts / largest / old --- */
function renderDrafts() {
  const r = state.report;
  const list = r ? r.drafts : [];
  return renderDataTab('drafts', list, 'Drafts & junk files');
}

function renderLargest() {
  const r = state.report;
  const list = r ? r.largestFiles : [];
  return renderDataTab('largest', list, 'Largest files');
}

function renderOld() {
  const r = state.report;
  const list = r ? r.oldFiles : [];
  return renderDataTab('old', list, 'Old files');
}

function renderDataTab(section, list, emptyMsg) {
  const filtered = state.q ? list.filter((f) => (f.path + ' ' + f.name).toLowerCase().includes(state.q)) : list;
  const rows = sortList(filtered);
  $('#tabToolbar').innerHTML = dataTabToolbar({ section });
  if (!rows.length) {
    $('#tabBody').innerHTML = emptyState(emptyMsg || 'No items.');
    refreshSelectionUI();
    return;
  }
  $('#tabBody').innerHTML = tableShell(rows.map((f) => fileRow(f, { selectable: true })), { selectable: true });
  refreshSelectionUI();
}

/* --- empty folders --- */
function renderEmpty() {
  const r = state.report;
  const dirs = r ? r.emptyDirs : [];
  $('#tabToolbar').innerHTML = selectionInfoHtml() + '<span class="spacer"></span>' +
    '<a class="btn small" href="/api/export?section=empty&format=csv">Export CSV</a>' +
    '<button id="btnDeleteSel" class="btn danger small" disabled>Delete selected folders</button>';
  if (!dirs.length) {
    $('#tabBody').innerHTML = emptyState('No empty folders found.');
    refreshSelectionUI();
    return;
  }
  const rows = dirs.map((p) => {
    const sel = state.selection.has(p);
    return '<tr class="' + (sel ? 'row-selected' : '') + '"><td><input type="checkbox" class="row-cb" data-path="' + escapeHtml(p) + '" data-size="0"' + (sel ? ' checked' : '') + '></td>' +
      '<td><span class="badge-cat dir">folder</span> <span class="fname">' + escapeHtml(p.split(/[\\/]/).pop()) + '</span></td>' +
      '<td class="num muted">0 B</td><td class="num muted">—</td>' +
      '<td class="path" title="' + escapeHtml(p) + '">' + escapeHtml(p) + '</td></tr>';
  }).join('');
  $('#tabBody').innerHTML = tableShell(rows, { selectable: true });
  refreshSelectionUI();
}

/* --- all files (server-side pagination) --- */
async function renderAll() {
  const p = state.allPage;
  p.q = state.q;
  p.sort = state.sort;
  p.order = state.order;
  const url = '/api/files?q=' + encodeURIComponent(p.q) + '&sort=' + p.sort + '&order=' + p.order +
    '&offset=' + p.offset + '&limit=' + p.limit;
  const d = await api(url);
  p.total = d.total;
  p.items = d.items;
  const pages = Math.max(1, Math.ceil(p.total / p.limit));
  const cur = Math.floor(p.offset / p.limit) + 1;
  $('#tabToolbar').innerHTML =
    '<input type="search" id="tabSearch" placeholder="Filter all files…" value="' + escapeHtml(state.q) + '">' +
    '<select id="tabSort"><option value="size"' + (p.sort === 'size' ? ' selected' : '') + '>Sort: size</option>' +
    '<option value="name"' + (p.sort === 'name' ? ' selected' : '') + '>Sort: name</option>' +
    '<option value="mtime"' + (p.sort === 'mtime' ? ' selected' : '') + '>Sort: modified</option></select>' +
    '<a class="btn small" href="/api/export?section=all&format=csv">Export CSV</a>' +
    '<span class="spacer"></span>' + selectionInfoHtml() +
    '<button id="btnDeleteSel" class="btn danger small" disabled>Delete selected</button>' +
    '<div class="pager"><button id="pgPrev" class="btn small" ' + (cur <= 1 ? 'disabled' : '') + '>‹ Prev</button>' +
    '<span>' + cur + ' / ' + pages + ' (' + p.total.toLocaleString() + ' files)</span>' +
    '<button id="pgNext" class="btn small" ' + (cur >= pages ? 'disabled' : '') + '>Next ›</button></div>';
  if (!p.items.length) {
    $('#tabBody').innerHTML = emptyState(p.total ? 'No matches.' : 'No files — run a scan first.');
    refreshSelectionUI();
    return;
  }
  $('#tabBody').innerHTML = tableShell(p.items.map((f) => fileRow(f, { selectable: true })), { selectable: true });
  refreshSelectionUI();
}

/* --- activity --- */
async function renderActivity() {
  $('#tabToolbar').innerHTML = '<span class="muted">Deletion & restore history</span>';
  const d = await api('/api/activity?limit=300');
  const entries = d.entries || [];
  if (!entries.length) {
    $('#tabBody').innerHTML = emptyState('No activity yet — deletions will be logged here.');
    return;
  }
  $('#tabBody').innerHTML = '<div class="act-list">' + entries.map((e) =>
    '<div class="act"><span class="ts">' + fmtDate(e.ts) + '</span>' +
    '<span class="a ' + (e.ok ? 'ok' : 'fail') + '">' + escapeHtml(e.action) + '</span>' +
    '<span class="p" title="' + escapeHtml(e.path || '') + '">' + escapeHtml(e.path || '') + '</span>' +
    '<span class="sz">' + (e.ok ? fmtBytes(e.size || 0) : (e.error || 'failed')) + '</span></div>').join('') + '</div>';
}

/* --- local trash --- */
async function renderTrash() {
  $('#tabToolbar').innerHTML = '<span class="muted">Project-local trash (fallback when the OS trash is unavailable)</span>';
  const d = await api('/api/trash');
  const items = (d.trash && d.trash.items) || [];
  if (!items.length) {
    $('#tabBody').innerHTML = emptyState('Local trash is empty. (The OS Recycle Bin / system trash is managed by the OS and is not listed here.)');
    return;
  }
  $('#tabBody').innerHTML = '<div class="table-wrap"><table><thead><tr>' +
    '<th>Name</th><th>Original path</th><th class="num">Size</th><th>Moved at</th><th></th></tr></thead><tbody>' +
    items.map((it) => '<tr><td class="fname">' + escapeHtml(it.name) + '</td>' +
      '<td class="path" title="' + escapeHtml(it.origPath || '') + '">' + escapeHtml(it.origPath || '—') + '</td>' +
      '<td class="num">' + it.sizeFormatted + '</td>' +
      '<td class="muted">' + fmtDate(it.movedAt) + '</td>' +
      '<td><button class="btn small" data-restore="' + escapeHtml(it.path) + '">Restore</button></td></tr>').join('') +
    '</tbody></table></div>';
}

/* ============================== delete flow ============================== */
function openDeleteModal() {
  const entries = [...state.selection.entries()];
  if (!entries.length) return;
  const total = entries.reduce((a, [, sz]) => a + (sz || 0), 0);
  const preview = entries.slice(0, 30).map(([p]) => '<div>' + escapeHtml(p) + '</div>').join('');
  const more = entries.length > 30 ? '<div class="muted">… and ' + (entries.length - 30) + ' more</div>' : '';
  $('#modalRoot').innerHTML =
    '<div class="modal-backdrop" id="modalBackdrop"><div class="modal">' +
    '<div class="modal-head"><h3>Delete ' + entries.length + ' item' + (entries.length > 1 ? 's' : '') + ' (' + fmtBytes(total) + ')</h3>' +
    '<button class="btn ghost small" id="modalClose">✕</button></div>' +
    '<div class="modal-body">' +
    '<div class="mode-option sel" data-mode="trash"><div><div class="t">Move to trash (recommended)</div>' +
    '<div class="d">Recoverable: Windows Recycle Bin / system trash (or the project-local trash fallback).</div></div></div>' +
    '<div class="mode-option" data-mode="permanent"><div><div class="t">Permanently delete</div>' +
    '<div class="d">Removes the items immediately — this cannot be undone.</div></div></div>' +
    '<div class="warn-box hidden" id="permWarn">Permanent deletion is irreversible. Please confirm below.</div>' +
    '<div class="check-line hidden" id="permCheckLine"><input type="checkbox" id="permCheck"><label for="permCheck">I understand these items will be permanently deleted and cannot be recovered.</label></div>' +
    '<div class="preview-list">' + preview + more + '</div>' +
    '</div>' +
    '<div class="modal-foot"><button class="btn ghost" id="modalCancel">Cancel</button>' +
    '<button class="btn danger" id="modalConfirm">Delete</button></div></div></div>';

  let mode = 'trash';
  const setMode = (m) => {
    mode = m;
    $$('.mode-option').forEach((el) => el.classList.toggle('sel', el.dataset.mode === m));
    const perm = m === 'permanent';
    $('#permWarn').classList.toggle('hidden', !perm);
    $('#permCheckLine').classList.toggle('hidden', !perm);
    $('#permCheck').checked = false;
    $('#modalConfirm').disabled = perm;
  };
  $$('.mode-option').forEach((el) => el.addEventListener('click', () => setMode(el.dataset.mode)));
  $('#permCheck').addEventListener('change', (e) => { $('#modalConfirm').disabled = !e.target.checked; });
  const close = () => { $('#modalRoot').innerHTML = ''; };
  $('#modalClose').addEventListener('click', close);
  $('#modalCancel').addEventListener('click', close);
  $('#modalBackdrop').addEventListener('click', (e) => { if (e.target === e.currentTarget) close(); });
  $('#modalConfirm').addEventListener('click', async () => {
    $('#modalConfirm').disabled = true;
    const paths = entries.map(([p]) => p);
    try {
      const d = await api('/api/delete', { method: 'POST', body: JSON.stringify({ paths, mode }) });
      const ok = d.results.filter((r) => r.ok).length;
      const failed = d.results.length - ok;
      toast(ok + ' deleted (' + mode + ')' + (failed ? ', ' + failed + ' failed' : '') + ' — ' + fmtBytes(total), ok ? 'ok' : 'err');
      state.selection.clear();
      close();
      await loadReport();
    } catch (e) {
      toast(e.message, 'err');
      $('#modalConfirm').disabled = false;
    }
  });
}

/* ============================== settings ============================== */
function openSettings() {
  const c = state.config || {};
  const ignores = (c.ignoreDirNames || []).join(', ');
  $('#modalRoot').innerHTML =
    '<div class="modal-backdrop" id="modalBackdrop"><div class="modal">' +
    '<div class="modal-head"><h3>Settings</h3><button class="btn ghost small" id="modalClose">✕</button></div>' +
    '<div class="modal-body">' +
    '<div class="settings-row"><label>Scan root</label><input id="setRoot" type="text" value="' + escapeHtml(c.root || '') + '" spellcheck="false"></div>' +
    '<div class="settings-row"><label>Old file threshold (days)</label><input id="setOld" type="number" min="1" value="' + (c.oldFileDays || 180) + '"></div>' +
    '<div class="settings-row"><label>Ignored folder names (comma separated)</label><textarea id="setIgnore">' + escapeHtml(ignores) + '</textarea></div>' +
    '<div class="settings-row"><label>Scan depth limit</label><input id="setDepth" type="number" min="1" value="' + (c.maxDepth || 40) + '"></div>' +
    '</div>' +
    '<div class="modal-foot"><button class="btn ghost" id="modalCancel">Cancel</button>' +
    '<button class="btn primary" id="modalSave">Save</button></div></div></div>';
  const close = () => { $('#modalRoot').innerHTML = ''; };
  $('#modalClose').addEventListener('click', close);
  $('#modalCancel').addEventListener('click', close);
  $('#modalBackdrop').addEventListener('click', (e) => { if (e.target === e.currentTarget) close(); });
  $('#modalSave').addEventListener('click', async () => {
    const body = {
      root: $('#setRoot').value.trim() || null,
      oldFileDays: Math.max(1, Number($('#setOld').value) || 180),
      maxDepth: Math.max(1, Number($('#setDepth').value) || 40),
      ignoreDirNames: $('#setIgnore').value.split(/[,\n]/).map((s) => s.trim()).filter(Boolean),
    };
    try {
      const d = await api('/api/config', { method: 'POST', body: JSON.stringify(body) });
      state.config = d.config;
      if (d.config.root) $('#rootInput').value = d.config.root;
      toast('Settings saved.', 'ok');
      close();
    } catch (e) { toast(e.message, 'err'); }
  });
}

/* ============================== events ============================== */
function bindEvents() {
  $('#btnScan').addEventListener('click', startScan);
  $('#btnCancel').addEventListener('click', async () => {
    try { await api('/api/scan/cancel', { method: 'POST' }); } catch (_) {}
    toast('Stopping scan…');
  });
  $('#btnSettings').addEventListener('click', openSettings);
  $('#rootInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') startScan(); });
  $('#tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    state.tab = btn.dataset.tab;
    renderTab();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#modalRoot').innerHTML = ''; });

  $('#tabToolbar').addEventListener('input', (e) => {
    if (e.target.id === 'tabSearch') {
      clearTimeout(state.searchTimer);
      state.searchTimer = setTimeout(() => {
        state.q = e.target.value.trim().toLowerCase();
        if (state.tab === 'all') state.allPage.offset = 0;
        renderTab();
      }, 300);
    }
  });
  $('#tabToolbar').addEventListener('change', (e) => {
    if (e.target.id === 'tabSort') {
      state.sort = e.target.value;
      if (state.tab === 'all') state.allPage.sort = state.sort;
      renderTab();
    }
  });
  $('#tabToolbar').addEventListener('click', (e) => {
    if (e.target.id === 'btnDeleteSel') openDeleteModal();
    if (e.target.id === 'pgPrev') { state.allPage.offset = Math.max(0, state.allPage.offset - state.allPage.limit); renderTab(); }
    if (e.target.id === 'pgNext') { state.allPage.offset += state.allPage.limit; renderTab(); }
  });

  $('#tabBody').addEventListener('change', (e) => {
    const cb = e.target.closest('.row-cb');
    if (!cb) return;
    const p = cb.dataset.path;
    if (cb.checked) state.selection.set(p, Number(cb.dataset.size) || 0);
    else state.selection.delete(p);
    refreshSelectionUI();
  });
  $('#tabBody').addEventListener('click', (e) => {
    const selAll = e.target.closest('#selectAllPage');
    if (selAll) {
      $$('.row-cb').forEach((cb) => {
        cb.checked = selAll.checked;
        if (selAll.checked) state.selection.set(cb.dataset.path, Number(cb.dataset.size) || 0);
        else state.selection.delete(cb.dataset.path);
      });
      refreshSelectionUI();
      return;
    }
    const restoreBtn = e.target.closest('[data-restore]');
    if (restoreBtn) {
      restoreBtn.disabled = true;
      api('/api/trash/restore', { method: 'POST', body: JSON.stringify({ path: restoreBtn.dataset.restore }) })
        .then((d) => { toast('Restored: ' + d.restored, 'ok'); renderTab(); })
        .catch((err) => { toast(err.message, 'err'); restoreBtn.disabled = false; });
      return;
    }
    const th = e.target.closest('th.sortable');
    if (th) {
      const key = th.dataset.sort;
      if (state.sort === key) state.order = state.order === 'asc' ? 'desc' : 'asc';
      else { state.sort = key; state.order = 'desc'; }
      if (state.tab === 'all') state.allPage.offset = 0;
      renderTab();
    }
  });
}

init();


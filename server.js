'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');
const { DiskScanner, buildDerived, publicReport } = require('./lib/scanner');
const { deleteItems, listLocalTrash, restoreFromLocalTrash, readAudit } = require('./lib/delete');

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const REPORT_FILE = path.join(ROOT_DIR, 'reports', 'latest-report.json');

/* ------------------------------ CLI / config ------------------------------ */

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; }
    else out[key] = true;
  }
  return out;
}

function loadConfig(cli) {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'config.json'), 'utf8')); } catch (_) {}
  const cfg = Object.assign({}, file);
  if (cli.root) cfg.root = path.resolve(String(cli.root));
  if (cli.port) cfg.port = Number(cli.port);
  if (cli.host) cfg.host = String(cli.host);
  cfg.dataDir = cfg.dataDir || path.join(ROOT_DIR, '.data');
  return cfg;
}

const cli = parseArgs(process.argv.slice(2));
if (cli.help) {
  console.log('Windows Disk Manager');
  console.log('Usage: node server.js [--root <path>] [--port <n>] [--host <ip>] [--open]');
  process.exit(0);
}
const config = loadConfig(cli);

/* --------------------------------- state --------------------------------- */

const state = {
  status: { state: 'idle', root: config.root || null, progress: null, note: null },
  report: null,          // full report incl. _internal
  cancelToken: { cancelled: false },
};

function persistReport(report) {
  try {
    fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true });
    fs.writeFileSync(REPORT_FILE, JSON.stringify(publicReport(report), null, 2), 'utf8');
  } catch (e) { console.error('persist report failed:', e.message); }
}

function loadPersistedReport() {
  try {
    const pub = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8'));
    if (pub && pub.meta && pub.meta.root) {
      // internal index is not persisted; files tab requires a fresh scan
      const report = Object.assign({}, pub, { _internal: { files: [], dirSizes: new Map(), totalDirs: 0, ignoredDirs: 0 }, persisted: true });
      state.report = report;
      state.status = { state: 'done', root: pub.meta.root, note: 'loaded from saved report; re-scan to enable the file list', progress: null };
      console.log('Loaded saved report from', pub.meta.root);
    }
  } catch (_) {}
}

/* --------------------------------- scan ---------------------------------- */

async function startScan(body) {
  if (state.status.state === 'scanning') return { error: 409, message: 'A scan is already running.' };
  const root = path.resolve(String(body && body.root || config.root || os.homedir()));
  if (!fs.existsSync(root)) return { error: 400, message: 'Path does not exist: ' + root };
  const st = await fs.promises.stat(root);
  if (!st.isDirectory()) return { error: 400, message: 'Not a directory: ' + root };
  config.root = root;
  state.cancelToken.cancelled = false;
  state.status = { state: 'scanning', root, progress: { processedFiles: 0, currentPath: root, startedAt: Date.now() }, note: null };

  const scanner = new DiskScanner(config);
  scanner.scan(root, {
    onProgress: (p) => {
      if (state.status.state === 'scanning' && state.status.progress) {
        state.status.progress = Object.assign({}, state.status.progress, p);
      }
    },
    isCancelled: () => state.cancelToken.cancelled,
  }).then(({ cancelled, report }) => {
    state.report = report;
    persistReport(report);
    state.status = {
      state: 'done',
      root,
      progress: null,
      note: cancelled ? 'Scan cancelled — showing partial report.' : null,
      finishedAt: new Date().toISOString(),
    };
    console.log('Scan finished' + (cancelled ? ' (cancelled)' : '') + ' in ' + report.meta.durationMs + ' ms; ' + report.totals.files + ' files, ' + report.totals.bytesFormatted);
  }).catch((err) => {
    state.status = { state: 'error', root, progress: null, error: err.message };
    console.error('Scan failed:', err);
  });
  return { ok: true, root };
}

/* ------------------------------ report update ----------------------------- */

function rebuildReportAfterDeletion(deletedPaths) {
  if (!state.report || !state.report._internal || !state.report._internal.files) return;
  const int = state.report._internal;
  const delSet = new Set(deletedPaths);
  const keep = [];
  for (const f of int.files) {
    if (delSet.has(f.path)) {
      const ds = int.dirSizes.get(f.parent);
      if (ds) { ds.size = Math.max(0, ds.size - f.size); ds.count = Math.max(0, ds.count - 1); }
    } else keep.push(f);
  }
  int.files = keep;
  for (const p of deletedPaths) {
    for (const key of Object.keys(int.dirSizes)) {
      if (key === p || key.startsWith(p + path.sep)) delete int.dirSizes[key];
    }
  }
  const oldMeta = state.report.meta;
  const rebuilt = buildDerived({
    files: int.files,
    dirSizes: int.dirSizes,
    totalDirs: int.totalDirs || 0,
    ignoredDirs: int.ignoredDirs || 0,
    errors: [],
    root: oldMeta.root,
    startedAt: Date.now() - (oldMeta.durationMs || 0),
    cancelled: false,
    config,
  });
  rebuilt.meta = Object.assign({}, oldMeta, { deletedAt: new Date().toISOString() });
  state.report = rebuilt;
  persistReport(rebuilt);
}

/* ---------------------------------- API ---------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function sendError(res, code, message) { sendJSON(res, code, { ok: false, error: message }); }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 25 * 1024 * 1024) { reject(new Error('Body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function csvField(v) {
  const s = String(v == null ? '' : v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function handleExport(section, format) {
  if (!state.report) return { error: 409, message: 'No scan report yet' };
  const rep = state.report;
  let rows = [];
  if (section === 'drafts') rows = rep.drafts;
  else if (section === 'largest') rows = rep.largestFiles;
  else if (section === 'old') rows = rep.oldFiles;
  else if (section === 'all') {
    if (!rep._internal || !rep._internal.files) return { error: 409, message: 'Full file index unavailable (saved report); run a new scan.' };
    rows = rep._internal.files.map((f) => ({
      path: f.path, name: f.name, size: f.size, sizeFormatted: '', mtime: new Date(f.mtime).toISOString(),
      category: f.category || '', ruleLabel: f.ruleLabel || '', ext: f.ext || '',
    }));
  } else return { error: 400, message: 'Unknown section: ' + section };

  if (format === 'json') {
    return { json: { section, exportedAt: new Date().toISOString(), root: rep.meta.root, count: rows.length, rows } };
  }
  const header = ['path', 'name', 'size', 'sizeFormatted', 'category', 'ruleLabel', 'modified'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([r.path, r.name, r.size, r.sizeFormatted || '', r.category || '', r.ruleLabel || '', r.mtime || ''].map(csvField).join(','));
  }
  return { csv: lines.join('\n') };
}

async function handleFiles(u) {
  if (!state.report) return { error: 409, message: 'No scan report yet' };
  if (!state.report._internal || !state.report._internal.files || state.report._internal.files.length === 0) {
    return { error: 409, message: 'Full file index unavailable (saved report); run a new scan.' };
  }
  const q = u.searchParams;
  const query = (q.get('q') || '').toLowerCase();
  const category = q.get('category') || '';
  const sort = q.get('sort') || 'size';
  const order = q.get('order') === 'asc' ? 1 : -1;
  const offset = Math.max(0, Number(q.get('offset')) || 0);
  const limit = Math.min(500, Math.max(1, Number(q.get('limit')) || 100));
  let list = state.report._internal.files;
  if (category === 'draft') list = list.filter((f) => f.category);
  if (query) list = list.filter((f) => f.path.toLowerCase().includes(query) || f.name.toLowerCase().includes(query));
  list = [...list].sort((a, b) => {
    let va = a[sort], vb = b[sort];
    if (va == null) va = 0;
    if (vb == null) vb = 0;
    if (typeof va === 'string') return va.localeCompare(String(vb)) * order;
    return (Number(va) - Number(vb)) * order;
  });
  const total = list.length;
  const page = list.slice(offset, offset + limit).map((f) => ({
    path: f.path, name: f.name, ext: f.ext || '', size: f.size,
    sizeFormatted: fmt(f.size), mtime: new Date(f.mtime).toISOString(),
    category: f.category || null, ruleLabel: f.ruleLabel || null,
  }));
  return { ok: true, total, offset, limit, items: page };
}

function fmt(n) {
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n; let u = -1;
  do { v /= 1024; u++; } while (v >= 1024 && u < units.length - 1);
  return v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2) + ' ' + units[u];
}

/* ------------------------------ static files ------------------------------ */

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

/* --------------------------------- server --------------------------------- */

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = u.pathname;
  try {
    if (req.method === 'GET' && p === '/api/status') {
      sendJSON(res, 200, { ok: true, status: state.status });
      return;
    }
    if (req.method === 'POST' && p === '/api/scan') {
      const body = await readBody(req);
      const r = await startScan(body);
      if (r.error) return sendError(res, r.error, r.message);
      sendJSON(res, 200, { ok: true, root: r.root });
      return;
    }
    if (req.method === 'POST' && p === '/api/scan/cancel') {
      state.cancelToken.cancelled = true;
      sendJSON(res, 200, { ok: true });
      return;
    }
    if (req.method === 'GET' && p === '/api/report') {
      if (!state.report) return sendError(res, 409, 'No scan report yet — start a scan first.');
      sendJSON(res, 200, { ok: true, report: publicReport(state.report) });
      return;
    }
    if (req.method === 'GET' && p === '/api/files') {
      const r = await handleFiles(u);
      if (r.error) return sendError(res, r.error, r.message);
      sendJSON(res, 200, r);
      return;
    }
    if (req.method === 'POST' && p === '/api/delete') {
      if (state.status.state === 'scanning') return sendError(res, 409, 'Cannot delete while a scan is running.');
      if (!state.report) return sendError(res, 409, 'No scan report yet.');
      const body = await readBody(req);
      if (!Array.isArray(body.paths) || body.paths.length === 0) return sendError(res, 400, 'paths must be a non-empty array.');
      if (body.mode !== 'trash' && body.mode !== 'permanent') return sendError(res, 400, 'mode must be "trash" or "permanent".');
      const results = await deleteItems(body.paths, { mode: body.mode, config, root: state.report.meta.root });
      const okPaths = results.filter((r) => r.ok).map((r) => path.resolve(r.path));
      if (okPaths.length) rebuildReportAfterDeletion(okPaths);
      sendJSON(res, 200, { ok: true, results, deleted: okPaths.length, failed: results.length - okPaths.length });
      return;
    }
    if (req.method === 'GET' && p === '/api/config') {
      const safe = Object.assign({}, config, { root: config.root || null, rootExists: config.root ? fs.existsSync(config.root) : false });
      sendJSON(res, 200, { ok: true, config: safe });
      return;
    }
    if (req.method === 'POST' && p === '/api/config') {
      const body = await readBody(req);
      for (const key of ['root', 'oldFileDays', 'maxDepth', 'concurrency', 'ignoreDirNames', 'draftPatterns', 'followSymlinks']) {
        if (body[key] !== undefined) config[key] = body[key];
      }
      if (body.root) config.root = path.resolve(String(body.root));
      const file = Object.assign({}, config);
      delete file.dataDir;
      fs.writeFileSync(path.join(ROOT_DIR, 'config.json'), JSON.stringify(file, null, 2), 'utf8');
      sendJSON(res, 200, { ok: true, config: Object.assign({}, config, { rootExists: config.root ? fs.existsSync(config.root) : false }) });
      return;
    }
    if (req.method === 'GET' && p === '/api/activity') {
      const limit = Number(u.searchParams.get('limit')) || 200;
      sendJSON(res, 200, { ok: true, entries: await readAudit(config, limit) });
      return;
    }
    if (req.method === 'GET' && p === '/api/trash') {
      sendJSON(res, 200, { ok: true, trash: await listLocalTrash(config) });
      return;
    }
    if (req.method === 'POST' && p === '/api/trash/restore') {
      const body = await readBody(req);
      if (!body.path) return sendError(res, 400, 'path required');
      const restored = await restoreFromLocalTrash(config, body.path);
      sendJSON(res, 200, { ok: true, restored });
      return;
    }
    if (req.method === 'GET' && p === '/api/export') {
      const section = u.searchParams.get('section') || 'drafts';
      const format = u.searchParams.get('format') || 'csv';
      const r = await handleExport(section, format);
      if (r.error) return sendError(res, r.error, r.message);
      if (r.json) return sendJSON(res, 200, r.json);
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="' + section + '-' + new Date().toISOString().slice(0, 10) + '.csv"',
      });
      res.end(r.csv);
      return;
    }
    if (p.startsWith('/api/')) { sendError(res, 404, 'Unknown endpoint: ' + p); return; }
    serveStatic(req, res, p);
  } catch (e) {
    console.error('Request error:', e);
    if (!res.headersSent) sendError(res, 500, e.message);
    else res.end();
  }
});

/* ---------------------------------- boot ---------------------------------- */

loadPersistedReport();

const port = config.port || 3177;
const host = config.host || '127.0.0.1';
server.listen(port, host, () => {
  const url = 'http://' + host + ':' + port;
  console.log('');
  console.log('  Windows Disk Manager dashboard: ' + url);
  console.log('  Scan root: ' + (config.root || '(not set — use the dashboard or --root)'));
  console.log('  API: ' + url + '/api/status   |   Reports: ' + url + '/api/report');
  console.log('');
  if (cli.open) {
    const opener = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const { execFile } = require('child_process');
    execFile(opener, [url], () => {});
  }
});

process.on('SIGINT', () => { console.log('\nStopping server.'); process.exit(0); });
process.on('SIGTERM', () => process.exit(0));

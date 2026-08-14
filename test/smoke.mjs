import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(process.argv[2] || '.');
const fixture = path.join(os.tmpdir(), 'wdm-smoke-' + Date.now());
const port = 3210 + Math.floor(Math.random() * 300);

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log('  PASS:', msg);
  else { console.log('  FAIL:', msg); failures++; }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function api(p, opts) {
  const res = await fetch('http://127.0.0.1:' + port + p, opts);
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + p + ': ' + (data.error || text.slice(0, 200)));
  return data;
}

/* ---- build fixture ---- */
function build() {
  fs.mkdirSync(fixture, { recursive: true });
  const w = (rel, content) => { const p = path.join(fixture, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };
  w('Documents/quarterly-report.docx', 'normal');
  w('Documents/meeting-notes.md', 'normal');
  w('Documents/old-project-notes.txt', 'ancient'); fs.utimesSync(path.join(fixture, 'Documents/old-project-notes.txt'), new Date(Date.now() - 400 * 86400000), new Date(Date.now() - 400 * 86400000));
  w('Documents/Project proposal draft v2.docx', 'draft');
  w('Documents/scratchpad draft.txt', 'draft');
  w('Documents/~$quarterly-report.docx', 'office lock');
  w('Documents/~$meeting-notes.docx', 'office lock');
  w('Documents/report.tmp', 'tmp');
  w('Documents/file.txt.swp', 'swp');
  w('Documents/Reports/budget.xlsx', 'normal');
  w('Downloads/installer-setup.exe.part', 'partial');
  w('Downloads/movie.crdownload', 'partial');
  w('Downloads/archive.zip', 'normal');
  w('Downloads/setup.exe', 'normal');
  w('Backups/config-backup.bak', 'bak');
  w('Backups/main.orig', 'orig');
  w('Backups/readme.txt', 'normal');
  w('Temp/cache.tmp', 'tmp');
  w('Temp/notes~', 'vim backup');
  w('Media/.DS_Store', 'junk');
  w('Media/Thumbs.db', 'junk');
  fs.writeFileSync(path.join(fixture, 'Media/video-clip.mp4'), Buffer.alloc(5 * 1024 * 1024));
  fs.mkdirSync(path.join(fixture, 'EmptyFolder/nested/empty2'), { recursive: true });
  fs.mkdirSync(path.join(fixture, 'Projects/src'), { recursive: true });
  fs.mkdirSync(path.join(fixture, 'Projects/node_modules/pkg'), { recursive: true });
  fs.mkdirSync(path.join(fixture, 'Projects/.git/objects'), { recursive: true });
  w('Projects/node_modules/pkg/index.js', 'ignored');
  w('Projects/.git/objects/abc123', 'ignored');
}

async function waitUp() {
  for (let i = 0; i < 100; i++) {
    try { const d = await api('/api/status'); return d; } catch (_) { await sleep(100); }
  }
  throw new Error('server did not start');
}

const officeLock = path.join(fixture, 'Documents', '~$quarterly-report.docx');
const dsStore = path.join(fixture, 'Media', '.DS_Store');

try {
  build();
  console.log('fixture at', fixture);

  const child = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--root', fixture, '--port', String(port)], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (d) => { serverLog += d; });
  child.stderr.on('data', (d) => { serverLog += d; });
  const kill = () => { try { child.kill('SIGTERM'); } catch (_) {} };

  try {
    await waitUp();
    assert(true, 'server responds on /api/status');

    const scanRes = await api('/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ root: fixture }) });
    assert(scanRes.ok && scanRes.root === fixture, 'scan started');

    let status;
    for (let i = 0; i < 300; i++) {
      status = (await api('/api/status')).status;
      if (status.state !== 'scanning') break;
      await sleep(100);
    }
    assert(status.state === 'done', 'scan finished (state=' + status.state + ')');

    const rep = (await api('/api/report')).report;
    assert(rep.totals.files === 22, 'total files = 22 (got ' + rep.totals.files + ')');
    assert(rep.totals.bytes >= 5 * 1024 * 1024, 'total bytes >= 5 MB (got ' + rep.totals.bytes + ')');
    assert(rep.totals.ignoredDirs === 2, 'ignored dirs = 2 (got ' + rep.totals.ignoredDirs + ')');
    assert(rep.drafts.length === 14, 'drafts = 14 (got ' + rep.drafts.length + ')');
    const cats = new Set(rep.drafts.map((f) => f.category));
    for (const c of ['draft', 'temp', 'backup', 'partial', 'junk']) assert(cats.has(c), 'draft category ' + c + ' present');
    assert(rep.oldFiles.length === 1, 'old files = 1 (got ' + rep.oldFiles.length + ')');
    assert(rep.emptyDirs.length === 5, 'empty dirs = 5 (got ' + rep.emptyDirs.length + ')');
    assert(rep.topLevel.length === 7, 'top-level entries = 7 (got ' + rep.topLevel.length + ')');
    assert(rep.largestFiles[0] && rep.largestFiles[0].name === 'video-clip.mp4', 'largest file is video-clip.mp4');
    const officeInDrafts = rep.drafts.some((f) => f.path === officeLock && f.ruleLabel === 'Office lock/temp files');
    assert(officeInDrafts, '~$ office temp detected with correct rule label');

    const filesPage = await api('/api/files?sort=size&order=desc&limit=5');
    assert(filesPage.total === 22 && filesPage.items.length === 5, '/api/files pagination total=22 limit=5');
    assert(filesPage.items[0].name === 'video-clip.mp4', '/api/files sorted by size desc');

    const del1 = await api('/api/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: [officeLock], mode: 'permanent' }) });
    assert(del1.deleted === 1 && del1.failed === 0, 'permanent delete of office lock succeeded');
    assert(!fs.existsSync(officeLock), 'office lock file removed from disk');

    const rep2 = (await api('/api/report')).report;
    assert(rep2.totals.files === 21, 'report totals updated to 21 after delete (got ' + rep2.totals.files + ')');
    assert(!rep2.drafts.some((f) => f.path === officeLock), 'deleted file removed from drafts list');

    const del2 = await api('/api/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: [dsStore], mode: 'trash' }) });
    assert(del2.deleted === 1, 'trash delete of .DS_Store succeeded');
    assert(!fs.existsSync(dsStore), '.DS_Store removed from original location');

    const bad = await api('/api/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: ['/etc/passwd'], mode: 'permanent' }) });
    assert(bad.results[0].ok === false && bad.failed === 1, 'delete outside scan root refused');

    const act = await api('/api/activity?limit=10');
    assert(act.entries.length >= 2, 'activity log has entries (got ' + act.entries.length + ')');

    const csv = await fetch('http://127.0.0.1:' + port + '/api/export?section=drafts&format=csv');
    const csvText = await csv.text();
    assert(csv.ok && csvText.startsWith('path,name,size'), 'CSV export works');

    const page = await fetch('http://127.0.0.1:' + port + '/');
    const html = await page.text();
    assert(page.ok && html.includes('Windows Disk Manager'), 'dashboard HTML served');

    const trash = await api('/api/trash');
    const trashItems = (trash.trash && trash.trash.items) || [];
    if (del2.results[0].method === 'local-trash') {
      assert(trashItems.length >= 1, 'local trash lists the .DS_Store item');
      if (trashItems.length) {
        const restored = await api('/api/trash/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: trashItems[0].path }) });
        assert(restored.ok && fs.existsSync(dsStore), 'restore from local trash works');
      }
    } else {
      console.log('  INFO: trash used system trash (method=' + del2.results[0].method + '), skipping local-trash restore checks');
    }

    kill();
    child.on('exit', () => {});
    console.log(failures === 0 ? '\nALL SMOKE TESTS PASSED' : '\n' + failures + ' TEST(S) FAILED');
    process.exit(failures === 0 ? 0 : 1);
  } catch (e) {
    kill();
    console.error('SMOKE TEST ERROR:', e.message);
    console.error('server log:\n' + serverLog.slice(-3000));
    process.exit(1);
  }
} catch (e) {
  console.error('SETUP ERROR:', e.message);
  process.exit(1);
}

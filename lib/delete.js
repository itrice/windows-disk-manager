'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { isInside } = require('./util');

const execFileAsync = promisify(execFile);

function auditLogPath(config) {
  return path.join(config.dataDir || '.data', 'audit.jsonl');
}

function localTrashRoot(config) {
  return path.join(config.dataDir || '.data', 'local-trash');
}

async function appendAudit(config, entry) {
  try {
    const p = auditLogPath(config);
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    await fs.promises.appendFile(p, JSON.stringify(entry) + '\n', 'utf8');
  } catch (_) { /* audit logging must never break a deletion */ }
}

/** Windows: move a file/folder to the Recycle Bin via PowerShell + VisualBasic. */
async function trashOnWindows(p, isDir) {
  const method = isDir ? 'DeleteDirectory' : 'DeleteFile';
  const escaped = p.replace(/'/g, "''");
  const script =
    "Add-Type -AssemblyName Microsoft.VisualBasic; " +
    "[Microsoft.VisualBasic.FileIO.FileSystem]::" + method + "('" + escaped +
    "','OnlyErrorDialogs','SendToRecycleBin')";
  await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
}

/** Move to the project-local trash folder, preserving the original path for restore. */
async function moveToLocalTrash(p, config, isDir) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.join(localTrashRoot(config), stamp);
  let dest = path.join(base, path.basename(p));
  let n = 1;
  while (fs.existsSync(dest)) dest = path.join(base, n++ + '_' + path.basename(p));
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.promises.rename(p, dest);
  } catch (e) {
    if (e.code === 'EXDEV') {
      await fs.promises.cp(p, dest, { recursive: true, force: true, errorOnExist: false });
      await fs.promises.rm(p, { recursive: true, force: true });
    } else {
      throw e;
    }
  }
  await fs.promises.writeFile(dest + '.meta.json', JSON.stringify({
    origPath: p, movedAt: new Date().toISOString(), isDir,
  }), 'utf8').catch(() => {});
  return dest;
}

/** POSIX: try gio trash (GTK trash spec); fall back to the local trash folder. */
async function trashOnPosix(p, config, isDir) {
  try {
    await execFileAsync('gio', ['trash', p], { timeout: 20000 });
    return { method: 'system-trash' };
  } catch (_) {
    const dest = await moveToLocalTrash(p, config, isDir);
    return { method: 'local-trash', dest };
  }
}

async function deleteItems(items, { mode, config, root }) {
  const results = [];
  const resolvedRoot = path.resolve(root);
  for (const raw of items) {
    const p = path.resolve(raw);
    if (p === resolvedRoot) {
      results.push({ path: raw, ok: false, error: 'Refusing to delete the scan root.' });
      continue;
    }
    if (!isInside(p, resolvedRoot)) {
      results.push({ path: raw, ok: false, error: 'Outside the scan root — refused for safety.' });
      continue;
    }
    let st = null;
    try { st = await fs.promises.lstat(p); } catch (e) { results.push({ path: raw, ok: false, error: e.message }); continue; }
    try {
      let detail = {};
      if (mode === 'trash') {
        if (process.platform === 'win32') {
          await trashOnWindows(p, st.isDirectory());
          detail.method = 'recycle-bin';
        } else {
          detail = await trashOnPosix(p, config, st.isDirectory());
        }
      } else {
        await fs.promises.rm(p, { recursive: true, force: true });
        detail.method = 'permanent';
      }
      const res = { path: raw, ok: true, size: st.size, isDir: st.isDirectory(), ...detail };
      results.push(res);
      await appendAudit(config, {
        ts: new Date().toISOString(), action: mode, path: raw, size: st.size,
        isDir: st.isDirectory(), ok: true, method: detail.method || mode,
      });
    } catch (e) {
      results.push({ path: raw, ok: false, error: e.message });
      await appendAudit(config, {
        ts: new Date().toISOString(), action: mode, path: raw, size: st ? st.size : 0,
        isDir: st ? st.isDirectory() : false, ok: false, error: e.message,
      });
    }
  }
  return results;
}

/** List local-trash contents (only the project-local fallback trash, not the OS trash). */
async function listLocalTrash(config) {
  const base = localTrashRoot(config);
  const items = [];
  let stamps;
  try { stamps = await fs.promises.readdir(base); } catch (_) { return { base, items: [] }; }
  for (const stamp of stamps) {
    const dir = path.join(base, stamp);
    let entries;
    try { entries = await fs.promises.readdir(dir); } catch (_) { continue; }
    for (const name of entries) {
      if (name.endsWith('.meta.json')) continue;
      const full = path.join(dir, name);
      let size = 0;
      let isDir = false;
      try {
        const st = await fs.promises.lstat(full);
        isDir = st.isDirectory();
        size = isDir ? await dirSize(full) : st.size;
      } catch (_) {}
      let origPath = null;
      try {
        const meta = JSON.parse(await fs.promises.readFile(full + '.meta.json', 'utf8'));
        origPath = meta.origPath || null;
      } catch (_) {}
      items.push({ stamp, name, path: full, origPath, size, sizeFormatted: formatSize(size), isDir, movedAt: stamp });
    }
  }
  items.sort((a, b) => b.stamp.localeCompare(a.stamp));
  return { base, items };
}

async function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = await fs.promises.readdir(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) {
        try { total += (await fs.promises.stat(full)).size; } catch (_) {}
      }
    }
  }
  return total;
}

/** Restore one local-trash item to its original location. */
async function restoreFromLocalTrash(config, itemPath) {
  const metaPath = itemPath + '.meta.json';
  let origPath = null;
  try {
    const meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf8'));
    origPath = meta.origPath;
  } catch (_) {}
  if (!origPath) throw new Error('Missing restore metadata for ' + itemPath);
  if (fs.existsSync(origPath)) throw new Error('Target already exists: ' + origPath);
  await fs.promises.mkdir(path.dirname(origPath), { recursive: true });
  try {
    await fs.promises.rename(itemPath, origPath);
  } catch (e) {
    if (e.code === 'EXDEV') {
      await fs.promises.cp(itemPath, origPath, { recursive: true, force: true, errorOnExist: false });
      await fs.promises.rm(itemPath, { recursive: true, force: true });
    } else throw e;
  }
  await fs.promises.rm(metaPath, { force: true }).catch(() => {});
  await appendAudit(config, { ts: new Date().toISOString(), action: 'restore', path: origPath, ok: true, method: 'local-trash' });
  return origPath;
}

async function readAudit(config, limit) {
  const p = auditLogPath(config);
  let text = '';
  try { text = await fs.promises.readFile(p, 'utf8'); } catch (_) { return []; }
  const lines = text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  lines.reverse();
  return lines.slice(0, limit || 200);
}

function formatSize(n) {
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n; let u = -1;
  do { v /= 1024; u++; } while (v >= 1024 && u < units.length - 1);
  return v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2) + ' ' + units[u];
}

module.exports = { deleteItems, listLocalTrash, restoreFromLocalTrash, readAudit, localTrashRoot, auditLogPath };

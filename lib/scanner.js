'use strict';

const fs = require('fs');
const path = require('path');
const { formatBytes } = require('./util');

/** Convert a simple glob pattern (* and ?) to a RegExp. Matching is case-insensitive. */
const SPECIAL_REGEX_CHARS = new Set(['\\', '.', '^', '$', '|', '(', ')', '[', ']', '{', '}', '+']);

function globToRegExp(pattern) {
  let re = '';
  for (const ch of pattern) {
    if (ch === '*') re += '.*';
    else if (ch === '?') re += '.';
    else if (SPECIAL_REGEX_CHARS.has(ch)) re += '\\' + ch;
    else re += ch;
  }
  return new RegExp('^' + re + '$', 'i');
}

class DiskScanner {
  constructor(config) {
    this.config = config;
    this.rules = (config.draftPatterns || []).map((r) => ({
      id: r.id,
      label: r.label,
      category: r.category,
      patterns: r.patterns || [],
      matchers: (r.patterns || []).map(globToRegExp),
    }));
  }

  matchRule(name) {
    for (const rule of this.rules) {
      for (const m of rule.matchers) {
        if (m.test(name)) return { ruleId: rule.id, ruleLabel: rule.label, category: rule.category };
      }
    }
    return null;
  }

  /**
   * Scan root and return { cancelled, report }.
   * opts: { onProgress, isCancelled, maxDepth, concurrency }
   */
  async scan(root, opts = {}) {
    const onProgress = opts.onProgress || (() => {});
    const isCancelled = opts.isCancelled || (() => false);
    const maxDepth = opts.maxDepth ?? this.config.maxDepth ?? 40;
    const concurrency = Math.max(1, opts.concurrency ?? this.config.concurrency ?? 12);
    const followSymlinks = !!this.config.followSymlinks;
    const ignore = new Set(this.config.ignoreDirNames || []);
    const startedAt = Date.now();

    const files = [];
    const dirSizes = new Map();
    const errors = [];
    let totalDirs = 0;
    let ignoredDirs = 0;
    let processed = 0;
    let lastProgress = 0;
    let cancelled = false;

    const queue = [{ dir: root, depth: 0 }];
    let active = 0;

    const recordFile = (full, name, st) => {
      const parent = path.dirname(full);
      const match = this.matchRule(name);
      const entry = {
        path: full,
        name,
        ext: path.extname(name).toLowerCase(),
        size: st.size,
        mtime: st.mtimeMs,
        category: match ? match.category : null,
        ruleId: match ? match.ruleId : null,
        ruleLabel: match ? match.ruleLabel : null,
        parent,
      };
      files.push(entry);
      processed++;
      const ds = dirSizes.get(parent);
      if (ds) {
        ds.size += st.size;
        ds.count++;
      } else {
        dirSizes.set(parent, { size: st.size, count: 1, depth: 0 });
      }
      if (processed - lastProgress >= 500) {
        lastProgress = processed;
        try { onProgress({ processedFiles: processed, currentPath: full }); } catch (_) {}
      }
    };

    const processDir = async (dir, depth) => {
      let entries;
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch (e) {
        errors.push({ path: dir, error: e.message });
        return;
      }
      totalDirs++;
      const existing = dirSizes.get(dir);
      dirSizes.set(dir, existing || { size: 0, count: 0, depth });

      const subdirs = [];
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (ignore.has(ent.name)) { ignoredDirs++; continue; }
          if (depth + 1 > maxDepth) continue;
          subdirs.push(full);
        } else if (ent.isFile()) {
          try {
            const st = await fs.promises.stat(full);
            recordFile(full, ent.name, st);
          } catch (e) {
            errors.push({ path: full, error: e.message });
          }
        } else if (ent.isSymbolicLink() && followSymlinks) {
          try {
            const st = await fs.promises.stat(full);
            if (st.isFile()) recordFile(full, ent.name, st);
            else if (st.isDirectory()) subdirs.push(full);
          } catch (e) {
            errors.push({ path: full, error: e.message });
          }
        }
        // sockets / fifos / devices are ignored
      }
      for (const s of subdirs) queue.push({ dir: s, depth: depth + 1 });
    };

    await new Promise((resolve) => {
      const pump = () => {
        while (active < concurrency && queue.length > 0 && !cancelled) {
          const item = queue.shift();
          active++;
          processDir(item.dir, item.depth)
            .catch((e) => { errors.push({ path: item.dir, error: e.message }); })
            .finally(() => { active--; pump(); });
        }
        if (active === 0) resolve();
      };
      pump();
    });

    cancelled = cancelled || isCancelled();

    // Bottom-up propagation of directory sizes (children before parents).
    const dirs = [...dirSizes.entries()].sort((a, b) => b[1].depth - a[1].depth);
    for (const [dirPath, info] of dirs) {
      const parent = path.dirname(dirPath);
      if (parent === dirPath) continue;
      const pinfo = dirSizes.get(parent);
      if (pinfo) { pinfo.size += info.size; pinfo.count += info.count; }
    }

    const report = buildDerived({
      files, dirSizes, totalDirs, ignoredDirs, errors,
      root, startedAt, cancelled, config: this.config,
    });
    return { cancelled, report };
  }
}

/**
 * Recompute all derived report fields from raw scan data.
 * data: { files, dirSizes, totalDirs, ignoredDirs, errors, root, startedAt, cancelled, config }
 * Mutates and returns the report object.
 */
function buildDerived(data) {
  const { files, dirSizes, root, config } = data;
  const now = Date.now();
  const oldCutoff = now - (config.oldFileDays ?? 180) * 86400000;
  const rootInfo = dirSizes.get(root) || { size: 0, count: 0, depth: 0 };
  const totalBytes = rootInfo.size;

  const row = (f) => ({
    path: f.path, name: f.name, ext: f.ext || '', size: f.size,
    sizeFormatted: formatBytes(f.size),
    mtime: new Date(f.mtime).toISOString(),
    category: f.category || null,
    ruleLabel: f.ruleLabel || null,
  });

  const draftEntries = files.filter((f) => f.category).sort((a, b) => b.size - a.size);
  const oldEntries = files.filter((f) => f.mtime < oldCutoff).sort((a, b) => b.size - a.size);
  const largest = [...files].sort((a, b) => b.size - a.size).slice(0, 200);

  const topLevel = [...dirSizes.entries()]
    .filter(([p]) => p !== root && path.dirname(p) === root)
    .map(([p, i]) => ({ path: p, name: path.basename(p) || p, size: i.size, sizeFormatted: formatBytes(i.size), count: i.count, share: totalBytes ? i.size / totalBytes : 0 }))
    .sort((a, b) => b.size - a.size);

  const topDirs = [...dirSizes.entries()]
    .filter(([p]) => p !== root)
    .map(([p, i]) => ({ path: p, size: i.size, sizeFormatted: formatBytes(i.size), count: i.count, depth: i.depth }))
    .sort((a, b) => b.size - a.size)
    .slice(0, 30);

  const extMap = new Map();
  for (const f of files) {
    const ext = f.ext || '(no ext)';
    const e = extMap.get(ext) || { ext, size: 0, count: 0 };
    e.size += f.size;
    e.count++;
    extMap.set(ext, e);
  }
  const extensions = [...extMap.values()]
    .map((e2) => Object.assign({}, e2, { sizeFormatted: formatBytes(e2.size) }))
    .sort((a, b) => b.size - a.size)
    .slice(0, 20);

  const emptyDirs = [...dirSizes.entries()]
    .filter(([p, i]) => p !== root && i.count === 0)
    .map(([p]) => p)
    .sort();

  const report = {
    meta: {
      version: 1,
      root,
      scannedAt: new Date(now).toISOString(),
      durationMs: now - data.startedAt,
      cancelled: !!data.cancelled,
      oldFileDays: config.oldFileDays ?? 180,
    },
    totals: {
      files: files.length,
      dirs: dirSizes.size + data.ignoredDirs,
      ignoredDirs: data.ignoredDirs,
      bytes: totalBytes,
      bytesFormatted: formatBytes(totalBytes),
    },
    topLevel,
    topDirs,
    extensions,
    largestFiles: largest.slice(0, 200).map(row),
    drafts: draftEntries.slice(0, 5000).map(row),
    oldFiles: oldEntries.slice(0, 5000).map(row),
    emptyDirs: emptyDirs.slice(0, 5000),
    emptyDirsTotal: emptyDirs.length,
    errors: (data.errors || []).slice(0, 200),
    _internal: { files, dirSizes, totalDirs: data.totalDirs, ignoredDirs: data.ignoredDirs },
  };
  return report;
}

/** Strip internal heavy fields; result is safe to serialize to the client. */
function publicReport(report) {
  if (!report) return null;
  const { _internal, ...pub } = report;
  return pub;
}

module.exports = { DiskScanner, buildDerived, publicReport, globToRegExp, formatBytes };

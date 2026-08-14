'use strict';

const path = require('path');

/** Human-readable byte size, e.g. 1.5 GB */
function formatBytes(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '0 B';
  if (n < 0) return '-' + formatBytes(-n);
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n;
  let u = -1;
  do { v /= 1024; u++; } while (v >= 1024 && u < units.length - 1);
  return v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2) + ' ' + units[u];
}

/** True when child === parent or child is nested under parent (resolved paths). */
function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

module.exports = { formatBytes, isInside };

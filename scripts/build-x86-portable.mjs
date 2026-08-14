#!/usr/bin/env node
// Builds dist/windows-disk-manager-32bit/ — a portable 32-bit package for
// 32-bit Windows 7 machines (pkg has no win-x86 base binary for Node 12).
// Uses the official Node.js 12.22.12 win-x86 runtime, so no installation needed.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(process.argv[2] || '.');
const NODE_X86_URL = 'https://nodejs.org/dist/v12.22.12/node-v12.22.12-win-x86.zip';
const NODE_DIR = 'node-v12.22.12-win-x86';
const OUT_DIR = path.join(ROOT, 'dist', 'windows-disk-manager-32bit');

function sh(cmd) { return execSync(cmd, { stdio: 'inherit', shell: true }); }

console.log('== Building 32-bit portable package ==');
fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

const zipPath = path.join(os.tmpdir(), 'node12-win-x86.zip');
if (!fs.existsSync(zipPath)) {
  console.log('Downloading Node 12.22.12 win-x86 runtime...');
  execSync('curl -sSL --retry 6 --retry-delay 3 --retry-all-errors -o "' + zipPath + '" ' + NODE_X86_URL, { stdio: 'inherit' });
}
const tmpNode = path.join(os.tmpdir(), NODE_DIR);
if (!fs.existsSync(path.join(tmpNode, 'node.exe'))) {
  execSync('cd "' + os.tmpdir() + '" && unzip -o -q "' + zipPath + '"', { stdio: 'inherit' });
}

fs.copyFileSync(path.join(tmpNode, 'node.exe'), path.join(OUT_DIR, 'node.exe'));
for (const item of ['server.js', 'config.json']) {
  fs.copyFileSync(path.join(ROOT, item), path.join(OUT_DIR, item));
}
fs.cpSync(path.join(ROOT, 'lib'), path.join(OUT_DIR, 'lib'), { recursive: true });
fs.cpSync(path.join(ROOT, 'public'), path.join(OUT_DIR, 'public'), { recursive: true });

fs.writeFileSync(path.join(OUT_DIR, 'start.bat'),
  '@echo off\r\n' +
  'cd /d "%~dp0"\r\n' +
  'echo Windows Disk Manager - 32-bit portable build (Node 12)\r\n' +
  'echo Dashboard: http://127.0.0.1:3177\r\n' +
  'node.exe server.js --open %*\r\n');

fs.writeFileSync(path.join(OUT_DIR, 'README.txt'),
  'Windows Disk Manager - 32-bit portable build (for 32-bit Windows 7)\r\n' +
  '==============================================================\r\n' +
  'No Node.js installation required - node.exe is included.\r\n' +
  '1. Double-click start.bat\r\n' +
  '2. The dashboard opens at http://127.0.0.1:3177\r\n' +
  'Optional: right-click start.bat > Edit to pass arguments, e.g.\r\n' +
  '   node.exe server.js --open --root "C:\\Users\\you"\r\n' +
  'Runtime data (config.json, .data, reports) is kept in this folder.\r\n');

console.log('Created ' + OUT_DIR);
const zipOut = path.join(ROOT, 'dist', 'windows-disk-manager-win-x86-portable.zip');
try {
  execSync('cd "' + path.join(ROOT, 'dist') + '" && zip -rq "' + zipOut + '" windows-disk-manager-32bit');
  console.log('Zipped: ' + zipOut);
} catch (_) {
  console.log('zip tool unavailable - folder built, zip skipped.');
}

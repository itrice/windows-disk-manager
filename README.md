# Windows Disk Manager

A zero-dependency Node.js tool that scans a folder on your disk, builds an analysis
report (folder sizes, file types, largest files, drafts / temp / backup / junk files,
old files, empty folders) and serves a web dashboard where you can review the report
and delete the selected items — moved to trash or permanently deleted — with explicit
confirmation and a full audit log.

Built for Windows in mind (Recycle Bin via PowerShell) but works on Linux and macOS too.

## Features

- Deep async directory scan with configurable depth, concurrency and ignored folders
- Analysis report: total size, file/folder counts, top-level folder breakdown,
  extension breakdown, largest files, old files, empty folders
- Draft & junk detection (all configurable):
  - Office lock/temp files (names starting with ~$)
  - Temp files (*.tmp, *.temp), editor swap files (*.swp, *.swo, names ending in ~)
  - Files named *draft*
  - Backup files (*.bak, *.backup, *.old, *.orig, *.rej)
  - Partial downloads (*.part, *.crdownload, *.download)
  - Junk (.DS_Store, Thumbs.db)
- Web dashboard, no build step, no npm dependencies:
  - Summary cards, folder-size bars, extension donut chart
  - Sortable / filterable tables with checkboxes
  - Delete flow with a preview list and confirmation
- Safe deletion:
  - Move to trash: Windows Recycle Bin, Linux/macOS system trash (gio),
    with a project-local trash fallback that can restore items
  - Permanently delete requires an extra confirmation
  - Refuses anything outside the scanned root
  - Every action is written to an audit log (shown in the Activity tab)
- Export any report section as CSV or JSON
- Latest report is persisted to reports/latest-report.json and survives a restart
  (run a new scan to re-enable the full file list)

## Requirements

- Node.js 18 or newer (tested with 22)
- No npm install required

## Quick start

    node server.js --root "C:/Users/you"

    # or without a root; type the path in the dashboard and click Scan
    node server.js

Then open the dashboard in your browser:

    http://127.0.0.1:3177

## CLI options

    node server.js [options]

    --root <path>   folder to scan (default: config.json root, else your home dir)
    --port <n>      HTTP port (default 3177)
    --host <ip>     bind address (default 127.0.0.1)
    --open          open the dashboard in your default browser
    --help          show this help

## Usage on Windows

1. Install Node.js LTS from nodejs.org
2. Open a terminal and run:

       node server.js --root "C:\Users\you"

   (or scan a whole drive with --root "C:\")
3. Open http://127.0.0.1:3177
4. Click Scan and wait for the report.
5. Open the Drafts tab, tick the rows you want to remove, click Delete selected.
   Choose "Move to trash" (Recycle Bin) or "Permanently delete" (irreversible).

## Config (config.json)

Created on first run. Fields:

    port            HTTP port (default 3177)
    host            bind address (default 127.0.0.1)
    root            scan root (can be set from the dashboard too)
    maxDepth        maximum directory depth to scan (default 40)
    concurrency     parallel directory readers (default 12)
    followSymlinks  whether to follow symbolic links (default false)
    oldFileDays     "old files" threshold in days (default 180)
    ignoreDirNames  folder names skipped entirely (node_modules, .git, ...)
    draftPatterns   detection rules: id, label, category, patterns (globs)
    dataDir         runtime data (audit log, local trash; default .data)

## HTTP API

    GET  /api/status                    scan state and progress
    POST /api/scan                      start a scan  { root? }
    POST /api/scan/cancel               stop the running scan
    GET  /api/report                    latest analysis report
    GET  /api/files                     paginated file index
         ?q=<text>&sort=size|name|mtime&order=asc|desc&offset=&limit=
    POST /api/delete                    delete selected items
         { paths: [...], mode: "trash" | "permanent" }
    GET  /api/config                    current configuration
    POST /api/config                    update configuration
    GET  /api/activity?limit=200        audit log (newest first)
    GET  /api/trash                     project-local trash listing
    POST /api/trash/restore             restore a local-trash item { path }
    GET  /api/export                    report export
         ?section=drafts|largest|old|all&format=csv|json

## Safety model

- Deletions are only allowed inside the scanned root; the root itself and any path
  outside it are refused by the server.
- Trash is the default and recommended mode; permanent deletion requires an extra
  checkbox in the confirmation dialog.
- The preview list in the dialog shows exactly which paths will be affected.
- Every action (trash, permanent, restore, failures) is appended to
  .data/audit.jsonl and shown in the Activity tab.
- If the OS trash is unavailable, items are moved to the project-local trash folder
  (.data/local-trash) and can be restored from the Local trash tab.
- On Windows, "Move to trash" sends items to the Recycle Bin via PowerShell
  (Microsoft.VisualBasic FileIO), so normal Windows restore applies.

## Development

Run the end-to-end smoke test (starts a server, scans a generated fixture,
verifies the report, deletion, audit log, export and safety guards):

    npm test

Project layout:

    server.js          HTTP server + REST API + static dashboard
    lib/scanner.js     async directory scanner, draft detection, report builder
    lib/delete.js      trash / permanent deletion, audit log, local-trash restore
    public/            dashboard (index.html, style.css, app.js) — no build step
    test/smoke.mjs     end-to-end tests
    reports/           persisted latest report
    .data/             runtime data (audit log, local trash)

## License

MIT

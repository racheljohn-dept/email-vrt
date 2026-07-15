const express = require('express');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

// This UI lives *inside* the VRT project (email-visual-tester-ui/ is a
// subfolder of the Playwright project root), so we resolve the project
// paths structurally instead of asking the user to type/remember one.
// Override with VRT_PROJECT_DIR if this ever needs to point elsewhere
// (e.g. running the UI from a different checkout).
const PROJECT_DIR = process.env.VRT_PROJECT_DIR || path.resolve(__dirname, '..');
const ENV_FILE = path.join(PROJECT_DIR, '.env');
const DATA_DIR = path.join(__dirname, 'data');
const REPORTS_DIR = path.join(__dirname, 'reports');
const DB_FILE = path.join(DATA_DIR, 'runs.json');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(REPORTS_DIR, { recursive: true });

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/report-assets', express.static(REPORTS_DIR));

/* ============================== store ============================== */

function loadDb() {
  if (!fs.existsSync(DB_FILE)) return { runs: {}, order: [] };
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
}
function saveDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
// Strip heavy fields for the sidebar list view.
function summarize(run) {
  const { logs, results, ...rest } = run;
  return rest;
}
function listRuns() {
  const db = loadDb();
  return db.order.map((id) => summarize(db.runs[id])).reverse();
}
function getRun(id) {
  return loadDb().runs[id] || null;
}
function createRun(run) {
  const db = loadDb();
  db.runs[run.id] = run;
  db.order.push(run.id);
  saveDb(db);
  return run;
}
function updateRun(id, patch) {
  const db = loadDb();
  if (!db.runs[id]) return null;
  db.runs[id] = { ...db.runs[id], ...patch };
  saveDb(db);
  return db.runs[id];
}
// NOTE: re-reads/re-writes the whole JSON file per log line. Fine for
// modest team usage; swap for SQLite if run/log volume grows a lot.
function appendLog(id, line) {
  const db = loadDb();
  if (!db.runs[id]) return;
  db.runs[id].logs = db.runs[id].logs || [];
  db.runs[id].logs.push(line);
  saveDb(db);
}
function annotate(id, client, note) {
  const db = loadDb();
  const run = db.runs[id];
  if (!run) return null;
  const r = (run.results || []).find((x) => x.client === client);
  if (r) r.note = note;
  saveDb(db);
  return run;
}

function effectiveStatus(r) {
  return r.overrideStatus || r.status;
}

// Lets a human override a client's detected pass/fail/skip — e.g. when a
// diff is a false positive from screenshot size/ratio rather than a real
// rendering issue. Recomputes the run's summary counts from the effective
// status so the UI and PDF both reflect the override immediately.
function overrideStatus(id, client, status) {
  const db = loadDb();
  const run = db.runs[id];
  if (!run) return null;
  const r = (run.results || []).find((x) => x.client === client);
  if (!r) return null;
  if (status) {
    r.overrideStatus = status;
  } else {
    delete r.overrideStatus;
  }
  const results = run.results || [];
  run.passed = results.filter((x) => effectiveStatus(x) === 'pass').length;
  run.failed = results.filter((x) => effectiveStatus(x) === 'fail').length;
  run.skipped = results.filter((x) => effectiveStatus(x) === 'skip').length;
  saveDb(db);
  return run;
}

/* ============================= .env I/O ============================= */

function readEnvFile() {
  if (!fs.existsSync(ENV_FILE)) return {};
  const out = {};
  fs.readFileSync(ENV_FILE, 'utf-8').split('\n').forEach((line) => {
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  });
  return out;
}
function writeEnvFile(settings) {
  const trimmed = Object.fromEntries(
    Object.entries(settings).map(([k, v]) => [k, String(v ?? '').trim()])
  );
  const merged = { ...readEnvFile(), ...trimmed };
  // Quoting every value protects against dotenv treating an unquoted '#'
  // as a comment (which silently truncates anything after it — the most
  // likely cause of a "credentials look right but 401" mismatch) and
  // against stray leading/trailing whitespace from copy-paste.
  const body = Object.entries(merged)
    .map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`)
    .join('\n') + '\n';
  fs.writeFileSync(ENV_FILE, body);
}

/* ========================= playwright runner ========================= */

function slug(s) {
  return (
    String(s || 'file').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) ||
    'file'
  );
}

function runPlaywright({ taskName, eoaTestId, sensitivity }, onLog) {
  return new Promise((resolvePromise, reject) => {
    const tempDir = path.join(PROJECT_DIR, 'temp');
    fs.mkdirSync(tempDir, { recursive: true });
    const jsonOutFile = path.join(tempDir, `pw-report-${Date.now()}.json`);

    const env = {
      ...process.env,
      TASK_NAME: taskName,
      // dotenv.config() in global-setup.ts won't overwrite a key that's
      // already present in process.env, so this wins over whatever (blank)
      // value sits in .env on disk.
      EXISTING_EOA_TEST_ID: eoaTestId,
      // Sensitivity slider is 0-10 (%); read as a ratio in blueprint.spec.ts.
      // See README for the one-line patch needed there.
      VRT_MAX_DIFF_RATIO: String((Number(sensitivity) || 0) / 100),
      PLAYWRIGHT_JSON_OUTPUT_NAME: jsonOutFile,
    };

    const child = spawn(
      'npx',
      ['playwright', 'test', 'tests/blueprint.spec.ts', '--reporter=json'],
      { cwd: PROJECT_DIR, env, shell: process.platform === 'win32' }
    );

    const pump = (stream) => {
      let carry = '';
      stream.on('data', (chunk) => {
        carry += chunk.toString();
        const lines = carry.split('\n');
        carry = lines.pop();
        lines.forEach((l) => l.trim() && onLog(l));
      });
    };
    pump(child.stdout);
    pump(child.stderr);

    child.on('error', (err) => reject(new Error(`Failed to launch Playwright: ${err.message}`)));
    child.on('close', (exitCode) => {
      if (!fs.existsSync(jsonOutFile)) {
        return reject(new Error(
          `Playwright JSON report not found at ${jsonOutFile} (exit code ${exitCode}). ` +
          `Check the run log for errors from globalSetup.`
        ));
      }
      try {
        const report = JSON.parse(fs.readFileSync(jsonOutFile, 'utf-8'));
        resolvePromise({ exitCode, report });
      } catch (e) {
        reject(new Error(`Failed to parse Playwright JSON report: ${e.message}`));
      }
    });
  });
}

// Walks the Playwright JSON reporter's suite tree into a flat list:
// { client, title, status, diffPct, actualImagePath, expectedImagePath, diffImagePath }
function parsePlaywrightReport(report) {
  const results = [];

  function walk(suite) {
    (suite.specs || []).forEach((spec) => {
      (spec.tests || []).forEach((t) => {
        const last = (t.results || [])[t.results.length - 1] || {};
        const clientAnn = (t.annotations || []).find((a) => a.type === 'client');
        const status =
          last.status === 'passed' ? 'pass' : last.status === 'skipped' ? 'skip' : 'fail';

        let diffPct = null;
        const msg = last.error && last.error.message;
        // Best-effort: Playwright's screenshot-diff failure message includes
        // "... pixels (ratio 0.0231 of ...)". Wording may shift between
        // versions — pass/fail is unaffected if this doesn't match.
        if (msg) {
          const m = msg.match(/ratio\s+([\d.]+)\s+of/i);
          if (m) diffPct = parseFloat(m[1]) * 100;
        }

        const find = (re) => (last.attachments || []).find((a) => re.test(a.name));
        // Our own unconditional capture (see blueprint.spec.ts) wins when
        // present; Playwright's built-in 'actual' only exists on failure.
        const capturedAttachment = find(/^captured$/i) || find(/actual/i);
        const expectedAttachment = find(/expected/i);
        const diffAttachment = find(/diff/i);

        results.push({
          client: clientAnn ? clientAnn.description : spec.title,
          title: spec.title,
          status,
          diffPct,
          actualImage: capturedAttachment || null,
          expectedImage: expectedAttachment || null,
          diffImage: diffAttachment || null,
        });
      });
    });
    (suite.suites || []).forEach(walk);
  }

  (report.suites || []).forEach(walk);
  return results;
}

// Copies actual/expected/diff screenshots out of the project's test-results
// (which Playwright may overwrite on the next run) into this server's own
// reports/<runId>/assets folder, so the UI and PDF have a stable source.
function copyRunAssets(runId, results) {
  const destDir = path.join(REPORTS_DIR, runId, 'assets');
  fs.mkdirSync(destDir, { recursive: true });

  // Attachments may report an on-disk `path` or an inline base64 `body`
  // depending on how they were attached — handle both.
  const writeOne = (attachment, base, tag) => {
    if (!attachment) return { path: null, url: null };
    const destName = `${base}-${tag}.png`;
    const destPath = path.join(destDir, destName);
    if (attachment.path && fs.existsSync(attachment.path)) {
      fs.copyFileSync(attachment.path, destPath);
    } else if (attachment.body) {
      fs.writeFileSync(destPath, Buffer.from(attachment.body, 'base64'));
    } else {
      return { path: null, url: null };
    }
    return { path: destPath, url: `/report-assets/${runId}/assets/${destName}` };
  };

  return results.map((r, i) => {
    const { actualImage, expectedImage, diffImage, ...rest } = r;
    const base = `${i}-${slug(r.client)}`;
    const actual = writeOne(actualImage, base, 'actual');
    const diff = writeOne(diffImage, base, 'diff');
    const expected = writeOne(expectedImage, base, 'expected');
    return {
      ...rest,
      actualImagePath: actual.path,
      actualUrl: actual.url,
      diffImagePath: diff.path,
      diffUrl: diff.url,
      expectedImagePath: expected.path,
      expectedUrl: expected.url,
    };
  });
}

/* ============================= pdf report ============================= */

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function toDataUri(filePath) {
  try {
    return `data:image/png;base64,${fs.readFileSync(filePath).toString('base64')}`;
  } catch {
    return null;
  }
}
function buildReportHtml(run) {
  const results = run.results || [];
  const effList = results.map(effectiveStatus);
  const passedCount = effList.filter((s) => s === 'pass').length;
  const failedCount = effList.filter((s) => s === 'fail').length;
  const skippedCount = effList.filter((s) => s === 'skip').length;

  const statusCellClass = (s) => (s === 'pass' ? 'pass' : s === 'fail' ? 'fail' : 'skip');

  const rows = results
    .map((r) => {
      const status = effectiveStatus(r);
      const manualTag = r.overrideStatus ? ' <span class="manual-tag">(manual)</span>' : '';
      return `<tr>
        <td>${esc(r.client)}</td>
        <td><span class="${statusCellClass(status)}">${status.toUpperCase()}</span>${manualTag}</td>
        <td>${r.diffPct != null ? r.diffPct.toFixed(2) + '%' : '—'}</td>
        <td>${r.note ? esc(r.note) : '—'}</td>
      </tr>`;
    })
    .join('');

  const visualCards = results
    .filter((r) => r.actualImagePath || r.diffImagePath)
    .map((r) => {
      const status = effectiveStatus(r);
      const actualImg = r.actualImagePath ? toDataUri(r.actualImagePath) : null;
      const diffImg = r.diffImagePath ? toDataUri(r.diffImagePath) : null;
      const images = [
        actualImg ? `<figure><img src="${actualImg}" /><figcaption>Captured</figcaption></figure>` : '',
        diffImg ? `<figure><img src="${diffImg}" /><figcaption>Difference heatmap</figcaption></figure>` : '',
      ].filter(Boolean).join('');
      const manualTag = r.overrideStatus ? ' <span class="manual-tag">(manual)</span>' : '';
      return `
        <div class="client-card ${status}">
          <strong>${esc(r.client)}</strong>
          <span class="${statusCellClass(status)}" style="float:right;">${status.toUpperCase()}${manualTag}</span>
          ${images ? `<div class="img-row">${images}</div>` : ''}
          ${r.note ? `<div class="note-box">${esc(r.note)}</div>` : ''}
        </div>`;
    })
    .join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body { font-family: sans-serif; max-width: 1000px; margin: 0 auto; padding: 30px; background: #f5f5f5; }
    .container { background: white; padding: 30px; border-radius: 8px; }
    h1 { border-bottom: 3px solid #0366d6; padding-bottom: 15px; }
    h2 { margin-top: 30px; border-left: 4px solid #0366d6; padding-left: 15px; }
    .summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; margin: 20px 0; }
    .summary-box { background: #f5f5f5; padding: 15px; border-radius: 6px; border-left: 4px solid #0366d6; }
    .summary-value { font-size: 24px; font-weight: 600; margin: 10px 0; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    th { background: #f5f5f5; padding: 12px; text-align: left; font-weight: 600; border-bottom: 2px solid #ddd; }
    td { padding: 10px 12px; border-bottom: 1px solid #ddd; vertical-align: top; }
    .pass { color: #28a745; font-weight: 600; }
    .fail { color: #d73a49; font-weight: 600; }
    .skip { color: #6b7280; font-weight: 600; }
    .manual-tag { font-size: 10px; color: #888; font-weight: 400; }
    .info-box { background: #f0f7ff; padding: 15px; border-radius: 6px; border-left: 3px solid #0366d6; margin: 15px 0; }
    code { background: #f5f5f5; padding: 2px 6px; border-radius: 3px; }
    .client-card { border: 1px solid #ddd; border-radius: 6px; padding: 15px; margin-bottom: 15px; page-break-inside: avoid; overflow: hidden; }
    .client-card.fail { border-left: 4px solid #d73a49; }
    .client-card.pass { border-left: 4px solid #28a745; }
    .client-card.skip { border-left: 4px solid #6b7280; }
    .img-row { display: flex; gap: 10px; margin-top: 10px; clear: both; }
    .img-row figure { flex: 1; margin: 0; }
    .img-row img { width: 100%; border: 1px solid #eee; border-radius: 6px; display: block; }
    .img-row figcaption { font-size: 10px; color: #888; text-align: center; margin-top: 4px; text-transform: uppercase; letter-spacing: 0.05em; }
    .note-box { background: #fffbea; border-left: 3px solid #d97706; padding: 10px 12px; border-radius: 6px; margin-top: 10px; font-size: 12px; font-style: italic; clear: both; }
  </style></head><body>
    <div class="container">
      <h1>Email QA Report — Visual Regression</h1>
      <p><strong>Generated:</strong> ${esc(new Date().toLocaleString())}</p>

      <h2>Run Details</h2>
      <div class="info-box"><strong>Task:</strong><br><code>${esc(run.taskName)}</code></div>
      <div class="info-box"><strong>EOA Test ID:</strong><br><code>${esc(run.eoaTestId || '—')}</code></div>
      <div class="info-box"><strong>Tester:</strong><br><code>${esc(run.tester || '—')}</code></div>

      <h2>Summary</h2>
      <div class="summary">
        <div class="summary-box"><div>Clients Tested</div><div class="summary-value">${results.length}</div></div>
        <div class="summary-box"><div>Passed</div><div class="summary-value" style="color:#28a745;">${passedCount}</div></div>
        <div class="summary-box"><div>Failed</div><div class="summary-value" style="color:#d73a49;">${failedCount}</div></div>
        <div class="summary-box"><div>Skipped</div><div class="summary-value" style="color:#6b7280;">${skippedCount}</div></div>
      </div>

      <h2>Results by Email Client</h2>
      <table>
        <tr><th>Client</th><th>Status</th><th>Diff %</th><th>Note</th></tr>
        ${rows || '<tr><td colspan="4">No results.</td></tr>'}
      </table>

      ${visualCards ? `<h2>Visual Differences</h2>${visualCards}` : ''}
    </div>
  </body></html>`;
}
async function generatePdf(run, outPath) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(buildReportHtml(run), { waitUntil: 'load' });
    await page.pdf({
      path: outPath,
      format: 'A4',
      printBackground: true,
      margin: { top: '20px', bottom: '20px', left: '20px', right: '20px' },
    });
  } finally {
    await browser.close();
  }
  return outPath;
}

/* =============================== SSE =============================== */

const buses = new Map();
function getBus(runId) {
  if (!buses.has(runId)) buses.set(runId, { emitter: new EventEmitter(), buffer: [] });
  return buses.get(runId);
}

/* ============================== routes ============================== */

app.get('/api/config', (req, res) => {
  res.json({ projectDir: PROJECT_DIR });
});

app.get('/api/runs', (req, res) => res.json(listRuns()));

app.get('/api/runs/:id', (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).send('Not found');
  res.json(run);
});

app.get('/api/runs/:id/stream', (req, res) => {
  const { id } = req.params;
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();

  const bus = getBus(id);
  bus.buffer.forEach((line) => res.write(`data: ${JSON.stringify({ type: 'log', text: line })}\n\n`));

  const onLog = (line) => res.write(`data: ${JSON.stringify({ type: 'log', text: line })}\n\n`);
  const onDone = (run) => {
    res.write(`data: ${JSON.stringify({ type: 'done', run })}\n\n`);
    res.end();
  };
  bus.emitter.on('log', onLog);
  bus.emitter.on('done', onDone);
  req.on('close', () => {
    bus.emitter.off('log', onLog);
    bus.emitter.off('done', onDone);
  });
});

// Serializes runs so two teammates hitting "Run" at once don't race the
// same project checkout (shared temp/, shared baselines, shared .env).
let runQueue = Promise.resolve();

app.post('/api/run', async (req, res) => {
  const { taskName, eoaTestId, sensitivity } = req.body || {};
  if (!taskName) return res.status(400).send('taskName is required');
  if (!eoaTestId) return res.status(400).send('eoaTestId is required');

  const runId = randomUUID();
  const run = {
    id: runId,
    taskName,
    eoaTestId,
    sensitivity,
    status: 'queued',
    startedAt: new Date().toISOString(),
    results: [],
    logs: [],
  };
  createRun(run);
  res.json({ runId });

  const bus = getBus(runId);
  const onLog = (line) => {
    bus.buffer.push(line);
    appendLog(runId, line);
    bus.emitter.emit('log', line);
  };

  runQueue = runQueue.then(async () => {
    updateRun(runId, { status: 'running' });
    try {
      const { report } = await runPlaywright({ taskName, eoaTestId, sensitivity }, onLog);
      const rawResults = parsePlaywrightReport(report);
      const results = copyRunAssets(runId, rawResults);
      const passed = results.filter((r) => r.status === 'pass').length;
      const failed = results.filter((r) => r.status === 'fail').length;
      const skipped = results.filter((r) => r.status === 'skip').length;

      const finished = updateRun(runId, {
        status: failed > 0 ? 'failed' : 'passed',
        finishedAt: new Date().toISOString(),
        results,
        passed,
        failed,
        skipped,
      });

      onLog('[server] Run complete. Add notes or override a client\'s status on the results page, then click "Generate PDF Report".');
      bus.emitter.emit('done', finished);
    } catch (e) {
      onLog(`[server] Run failed: ${e.message}`);
      const finished = updateRun(runId, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        error: e.message,
      });
      bus.emitter.emit('done', finished);
    } finally {
      buses.delete(runId);
    }
  });
});

app.post('/api/runs/:id/annotate', (req, res) => {
  const { client, note } = req.body || {};
  const run = annotate(req.params.id, client, note);
  if (!run) return res.status(404).send('Not found');
  res.json(run);
});

app.post('/api/runs/:id/tester', (req, res) => {
  const { tester } = req.body || {};
  const run = updateRun(req.params.id, { tester: tester || '' });
  if (!run) return res.status(404).send('Not found');
  res.json(run);
});

// Lets a human override a client's pass/fail/skip verdict — e.g. a diff
// that's a false positive from screenshot size/ratio rather than a real
// rendering issue. status: 'pass' | 'fail' | 'skip' | null (clears override).
app.post('/api/runs/:id/override', (req, res) => {
  const { client, status } = req.body || {};
  if (!client) return res.status(400).send('client is required');
  const run = overrideStatus(req.params.id, client, status || null);
  if (!run) return res.status(404).send('Not found');
  res.json(run);
});

// Builds (or rebuilds) the PDF from the run's current state — including
// whatever notes and status overrides have been added since the run
// finished. Called on demand rather than automatically at run completion,
// so edits can happen first.
app.post('/api/runs/:id/generate-report', async (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).send('Not found');
  try {
    const pdfPath = path.join(REPORTS_DIR, `${run.id}.pdf`);
    await generatePdf(run, pdfPath);
    const updated = updateRun(run.id, { reportPdfPath: pdfPath });
    res.json(updated);
  } catch (e) {
    res.status(500).send(
      `PDF generation failed: ${e.message}. If this persists, run "npx playwright install chromium" inside email-visual-tester-ui.`
    );
  }
});

app.get('/api/runs/:id/report', (req, res) => {
  const run = getRun(req.params.id);
  if (!run || !run.reportPdfPath || !fs.existsSync(run.reportPdfPath)) {
    return res.status(404).send('Report not ready yet');
  }
  res.download(run.reportPdfPath, `${run.taskName}-report.pdf`);
});

app.get('/api/settings', (req, res) => {
  const env = readEnvFile();
  res.json({
    EMAIL_PREVIEW_SERVICE: env.EMAIL_PREVIEW_SERVICE || 'emailonacid',
    hasCredentials: !!(env.EMAILONACID_API_KEY && env.EMAILONACID_ACCOUNT_PASSWORD),
  });
});

app.post('/api/settings', (req, res) => {
  try {
    writeEnvFile(req.body.settings || {});
    res.json({ ok: true });
  } catch (e) {
    res.status(400).send(e.message);
  }
});

const PORT = process.env.PORT || 4500;
app.listen(PORT, () => {
  console.log(`Email QA server running at http://localhost:${PORT}`);
  console.log(`Running Playwright against: ${PROJECT_DIR}`);
});

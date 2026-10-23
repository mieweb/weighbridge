#!/usr/bin/env node
// weighbridge — the scale your npm package crosses before it ships.
//
// Subcommands:
//   (default)  measure + gate against weighbridge.json limits; if a
//              weigh-ins.jsonl history file is present in the cwd, the job
//              summary / PR comment gains sparklines and headroom columns
//   trend      render sparkline history from a repo's weigh-ins branch
//   badges     write shields.io endpoint badge JSONs from the last report
//   ticket     print a release "weigh ticket" markdown table
//
// Gate usage:   weighbridge [--config weighbridge.json] [--write-baseline]
// Trend usage:  weighbridge trend [--repo owner/repo] [--file weigh-ins.jsonl]
//                 [--releases] [--last 30] [--metric <substring>]
// Badges usage: weighbridge badges [--report weighbridge-report.json] [--out .]
// Ticket usage: weighbridge ticket [--report weighbridge-report.json]
//                 [--file weigh-ins.jsonl] [--repo owner/repo] [--ref <tag>]

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync, appendFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

const args = process.argv.slice(2);
const sub = args[0] && !args[0].startsWith('-') ? args.shift() : 'gate';
const argVal = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : dflt;
};

// ---- shared helpers ----------------------------------------------------------
const fmt = (bytes) => bytes >= 1024 * 1024 ? `${(bytes / 1048576).toFixed(2)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
const fmtVal = (v, unit) => unit === 'bytes' ? fmt(v) : `${Math.round(v)} ms`;
const unitOf = (metric) => /gzip|pack/.test(metric) ? 'bytes' : 'ms';
const SPARK = '▁▂▃▄▅▆▇█';
const sparkline = (values) => {
  const min = Math.min(...values), max = Math.max(...values), span = max - min;
  return values.map((v) => SPARK[span === 0 ? 0 : Math.min(7, Math.floor(((v - min) / span) * 8))]).join('');
};

function detectRepo() {
  const url = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  const m = url.match(/github\.com[:/]([^/]+\/[^/\s]+?)(?:\.git)?$/);
  if (!m) throw new Error(`cannot derive owner/repo from origin remote: ${url}`);
  return m[1];
}

const parseHistory = (text) => text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

async function loadHistory({ file, repo }) {
  if (file && existsSync(file)) return parseHistory(readFileSync(file, 'utf8'));
  const r = repo ?? detectRepo();
  const res = await fetch(`https://raw.githubusercontent.com/${r}/weigh-ins/weigh-ins.jsonl`);
  if (!res.ok) throw new Error(`no weigh-ins history for ${r} (HTTP ${res.status}) — has the trend workflow run on main yet?`);
  return parseHistory(await res.text());
}

// ---- trend: terminal sparklines ------------------------------------------------
if (sub === 'trend') {
  const history = await loadHistory({ file: argVal('--file', 'weigh-ins.jsonl'), repo: argVal('--repo') });
  let rows = history;
  if (args.includes('--releases')) rows = rows.filter((r) => r.event === 'release');
  rows = rows.slice(-Number(argVal('--last', '30')));
  const filter = argVal('--metric', '');
  if (rows.length < 2) { console.log(`only ${rows.length} weigh-in(s) — nothing to trend yet.`); process.exit(0); }
  const metrics = [...new Set(rows.flatMap((r) => Object.keys(r.metrics ?? {})))].filter((m) => m.includes(filter));
  const label = (r) => r.event === 'release' ? r.ref : r.sha?.slice(0, 7);
  console.log(`weighbridge trend — ${rows.length} weigh-ins (${label(rows[0])} → ${label(rows.at(-1))})\n`);
  const pad = Math.max(...metrics.map((m) => m.length)) + 2;
  for (const m of metrics) {
    const vals = rows.map((r) => r.metrics?.[m]).filter((v) => typeof v === 'number');
    if (vals.length < 2) continue;
    const unit = unitOf(m);
    const pct = vals[0] === 0 ? null : ((vals.at(-1) - vals[0]) / vals[0]) * 100;
    const delta = pct == null ? '' : Math.abs(pct) < 0.5 ? '(steady)' : `(${pct > 0 ? '+' : ''}${pct.toFixed(1)}%)`;
    console.log(`${m.padEnd(pad)}${sparkline(vals)}  ${fmtVal(vals[0], unit)} → ${fmtVal(vals.at(-1), unit)}  ${delta}`);
  }
  process.exit(0);
}

// ---- badges: shields.io endpoint JSONs ----------------------------------------
if (sub === 'badges') {
  const report = JSON.parse(readFileSync(resolve(argVal('--report', 'weighbridge-report.json')), 'utf8'));
  const outDir = resolve(argVal('--out', '.'));
  mkdirSync(outDir, { recursive: true });
  const color = (r) => r.budget == null ? 'informational' : !r.ok ? 'red' : r.value / r.budget >= 0.8 ? 'yellow' : 'brightgreen';
  const slug = (s) => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  let count = 0;
  for (const r of report.results) {
    if (!Number.isFinite(r.value)) continue;
    const badge = { schemaVersion: 1, label: r.metric, message: fmtVal(r.value, r.unit) + (/gzip/.test(r.metric) ? ' gz' : ''), color: color(r) };
    writeFileSync(join(outDir, `badge-${slug(r.metric)}.json`), JSON.stringify(badge) + '\n');
    count++;
  }
  // headline badge: the main entry's gzip weight if present, else the first metric
  const headline = report.results.find((r) => r.metric === 'bundle . gzip') ?? report.results.find((r) => Number.isFinite(r.value));
  if (headline) {
    writeFileSync(join(outDir, 'badge.json'), JSON.stringify({
      schemaVersion: 1, label: 'curb weight', message: fmtVal(headline.value, headline.unit) + (/gzip/.test(headline.metric) ? ' gz' : ''), color: color(headline),
    }) + '\n');
    count++;
  }
  console.log(`wrote ${count} badge file(s) to ${outDir}`);
  process.exit(0);
}

// ---- ticket: release weigh ticket markdown ------------------------------------
if (sub === 'ticket') {
  const report = JSON.parse(readFileSync(resolve(argVal('--report', 'weighbridge-report.json')), 'utf8'));
  const ref = argVal('--ref', '');
  let prev = null;
  try {
    const history = await loadHistory({ file: argVal('--file', 'weigh-ins.jsonl'), repo: argVal('--repo') });
    prev = history.filter((r) => r.event === 'release' && r.ref !== ref).at(-1) ?? null;
  } catch { /* no history yet: ticket without deltas */ }
  const lines = ['', '### ⚖ Weighbridge ticket', '', `| metric | this release |${prev ? ` ${prev.ref} | Δ |` : ''}`, `|---|---|${prev ? '---|---|' : ''}`];
  for (const r of report.results) {
    if (!Number.isFinite(r.value)) continue;
    let tail = '';
    if (prev) {
      const p = prev.metrics?.[r.metric];
      const d = typeof p === 'number' ? r.value - p : null;
      tail = ` ${typeof p === 'number' ? fmtVal(p, r.unit) : '—'} | ${d == null ? '—' : (d >= 0 ? '+' : '−') + fmtVal(Math.abs(d), r.unit)} |`;
    }
    lines.push(`| ${r.metric} | ${fmtVal(r.value, r.unit)} |${tail}`);
  }
  console.log(lines.join('\n'));
  process.exit(0);
}

// ---- gate (default): measure, limit-check, summarize --------------------------
if (sub !== 'gate') { console.error(`unknown subcommand: ${sub}`); process.exit(2); }

const configPath = resolve(argVal('--config', 'weighbridge.json'));
const writeBaseline = args.includes('--write-baseline');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const results = []; // { metric, value, budget, unit, ok, note }
const record = (metric, value, budget, unit, note = '') => {
  const ok = budget == null || value <= budget;
  results.push({ metric, value, budget: budget ?? null, unit, ok, note });
  const show = unit === 'bytes' ? fmt(value) : `${value.toFixed(0)} ${unit}`;
  const cap = budget == null ? '' : ` (limit ${unit === 'bytes' ? fmt(budget) : budget + ' ' + unit})`;
  console.log(`${ok ? 'ok  ' : 'OVER'} ${metric}: ${show}${cap}${note ? ` — ${note}` : ''}`);
};

// Vite's manifest distinguishes startup imports from lazy dynamic imports.
if (config.vite) {
  const vite = config.vite;
  const distDir = resolve(vite.dist ?? 'dist');
  const manifestPath = resolve(vite.manifest ?? join(vite.dist ?? 'dist', '.vite/manifest.json'));
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Vite manifest not found: ${manifestPath}`);
    throw new Error(`Cannot read Vite manifest ${manifestPath}: ${error.message}`);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`Invalid Vite manifest: ${manifestPath}`);
  }

  const staticChunks = (source) => {
    const chunks = new Set();
    const visit = (key) => {
      if (chunks.has(key)) return;
      const chunk = manifest[key];
      if (!chunk) throw new Error(`Vite manifest entry not found for "${key}"`);
      chunks.add(key);
      for (const imported of chunk.imports ?? []) visit(imported);
    };
    visit(source);
    return chunks;
  };
  const gzipChunks = (chunks) => [...chunks].reduce((total, key) => {
    const chunk = manifest[key];
    if (typeof chunk.file !== 'string') throw new Error(`Vite manifest entry "${key}" has no output file`);
    const outputPath = resolve(distDir, chunk.file);
    const outputRelative = relative(distDir, outputPath);
    if (outputRelative.startsWith('..') || isAbsolute(outputRelative)) {
      throw new Error(`Vite manifest output is outside dist for "${key}": ${chunk.file}`);
    }
    let bytes;
    try {
      bytes = readFileSync(outputPath);
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`Vite chunk file not found for "${key}": ${chunk.file}`);
      throw error;
    }
    return total + gzipSync(bytes).length;
  }, 0);

  const shellEntries = Object.keys(manifest).filter((key) => manifest[key].isEntry);
  if (!shellEntries.length) throw new Error(`Vite manifest has no isEntry chunks: ${manifestPath}`);
  const shellChunks = new Set(shellEntries.flatMap((key) => [...staticChunks(key)]));
  record('app shell gzip', gzipChunks(shellChunks), vite.shell?.maxGzipBytes, 'bytes');
  for (const route of vite.routes ?? []) {
    if (!manifest[route.source]) {
      throw new Error(`Vite route source not found in manifest: ${route.source}`);
    }
    const routeChunks = staticChunks(route.source);
    const beyondShell = new Set([...routeChunks].filter((key) => !shellChunks.has(key)));
    record(`route ${route.name} gzip`, gzipChunks(beyondShell), route.maxGzipBytes, 'bytes');
  }
}

// 1. npm pack size (shipping weight)
if (config.pack) {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const info = JSON.parse(out.slice(out.indexOf('[')))[0];
  record('pack tarball', info.size, config.pack.maxTarballBytes, 'bytes');
  record('pack unpacked', info.unpackedSize, config.pack.maxUnpackedBytes, 'bytes', `${info.entryCount} files`);
  for (const [name, sec] of Object.entries(config.pack.sections ?? {})) {
    const bytes = info.files.filter((f) => f.path.startsWith(sec.prefix)).reduce((s, f) => s + f.size, 0);
    record(`pack section ${name}`, bytes, sec.maxBytes, 'bytes', bytes === 0 ? 'absent' : '');
  }
}

// 2. bundle size per entry (esbuild min + gzip)
const es = config.esbuild ?? {};
const esbuildSpec = `esbuild@${es.version ?? '0.25.0'}`;
const tmp = mkdtempSync(join(tmpdir(), 'weighbridge-'));
for (const entry of config.entries ?? []) {
  if (entry.maxGzipBytes == null && !entry.bundle) continue;
  const outfile = join(tmp, entry.path.replaceAll('/', '_') + '.min.js');
  const externals = [...(es.external ?? []), ...(entry.external ?? [])];
  const cmd = spawnSync('npx', [
    '-y', esbuildSpec, entry.path, '--bundle', '--minify', '--format=esm',
    `--platform=${entry.platform ?? es.platform ?? 'browser'}`,
    ...externals.map((e) => `--external:${e}`),
    `--outfile=${outfile}`,
  ], { encoding: 'utf8' });
  if (cmd.status !== 0) {
    record(`bundle ${entry.name} gzip`, Infinity, entry.maxGzipBytes, 'bytes', `esbuild failed: ${cmd.stderr.split('\n')[0]}`);
    continue;
  }
  const min = readFileSync(outfile);
  record(`bundle ${entry.name} gzip`, gzipSync(min).length, entry.maxGzipBytes, 'bytes', `min ${fmt(min.length)}`);
}
rmSync(tmp, { recursive: true, force: true });

// 3. import time + RSS per entry (fresh node process, median of 3)
const importProbe = `const t=performance.now();import(process.argv[1]).then(()=>{
  console.log(JSON.stringify({ms:performance.now()-t,rss:process.memoryUsage().rss}));
}).catch(e=>{console.error(e.message);process.exit(1)})`;
for (const entry of config.entries ?? []) {
  if (entry.maxImportMs == null) continue;
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', importProbe, resolve(entry.path)], { encoding: 'utf8' });
    if (r.status !== 0) { runs.length = 0; record(`import ${entry.name}`, Infinity, entry.maxImportMs, 'ms', r.stderr.trim().split('\n')[0]); break; }
    runs.push(JSON.parse(r.stdout));
  }
  if (!runs.length) continue;
  runs.sort((a, b) => a.ms - b.ms);
  const med = runs[1];
  record(`import ${entry.name}`, med.ms, entry.maxImportMs, 'ms', `rss ${fmt(med.rss)} (report-only)`);
}

// 4. command startup (e.g. CLI --help)
for (const cmd of config.commands ?? []) {
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    const r = spawnSync(cmd.command[0], cmd.command.slice(1), { stdio: 'ignore' });
    if (r.status !== 0) { runs.length = 0; record(`cmd ${cmd.name}`, Infinity, cmd.maxMs, 'ms', `exit ${r.status}`); break; }
    runs.push(performance.now() - t);
  }
  if (!runs.length) continue;
  runs.sort((a, b) => a - b);
  record(`cmd ${cmd.name}`, runs[1], cmd.maxMs, 'ms');
}

// ---- report + summary ---------------------------------------------------------
const baselinePath = resolve('weighbridge-baseline.json');
const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : null;
const historyPath = resolve('weigh-ins.jsonl');
const history = existsSync(historyPath) ? parseHistory(readFileSync(historyPath, 'utf8')) : null;
const report = { date: new Date().toISOString(), results };
writeFileSync('weighbridge-report.json', JSON.stringify(report, null, 2) + '\n');
if (writeBaseline) writeFileSync(baselinePath, JSON.stringify(report, null, 2) + '\n');

// Markdown summary: sparkline of main history with this run appended as ●,
// Δ vs baseline (main's latest report), and headroom against the limit.
const rows = results.map((r) => {
  const base = baseline?.results.find((b) => b.metric === r.metric);
  const hist = history?.map((row) => row.metrics?.[r.metric]).filter((v) => typeof v === 'number') ?? [];
  const spark = hist.length >= 2 && Number.isFinite(r.value)
    ? '`' + sparkline([...hist.slice(-14), r.value]) + '` ●' : '—';
  const delta = base && Number.isFinite(r.value) && Number.isFinite(base.value) ? r.value - base.value : null;
  const headroom = r.budget != null && Number.isFinite(r.value) ? r.value / r.budget : null;
  const icon = !r.ok ? '❌' : headroom != null && headroom >= 0.9 ? '⚠️' : '✅';
  const show = (v) => fmtVal(v, r.unit);
  return `| ${icon} | ${r.metric} | ${spark} | ${Number.isFinite(r.value) ? show(r.value) : 'error'} | ${delta == null ? '—' : (delta >= 0 ? '+' : '−') + show(Math.abs(delta))} | ${r.budget == null ? '—' : show(r.budget)} | ${headroom == null ? '—' : Math.round(headroom * 100) + '%'} |`;
});
const summary = [
  '<!-- weighbridge -->',
  '## ⚖ Weighbridge',
  '',
  '| | metric | trend | value | Δ main | limit | headroom |',
  '|---|---|---|---|---|---|---|',
  ...rows,
  '',
  `_trend = last ${Math.min(14, history?.length ?? 0)} main weigh-ins, ● = this run · [weighbridge](https://github.com/mieweb/weighbridge)_`,
].join('\n') + '\n';
writeFileSync('weighbridge-summary.md', summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);

const failures = results.filter((r) => !r.ok);
if (failures.length) {
  console.error(`\n${failures.length} weight limit(s) exceeded. Either shrink the change or consciously raise the limit in ${configPath}.`);
  process.exit(1);
}
console.log('\nAll weight limits met — cleared to ship.');

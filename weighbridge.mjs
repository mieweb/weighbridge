#!/usr/bin/env node
// weighbridge — the scale your package crosses before it ships. Measures curb
// weight (what an embedding app carries before loading any cargo of its own):
// pack size, per-entry bundle size (esbuild min+gzip), fresh-process import
// time/RSS, and command startup time. Config-driven via weighbridge.json so
// any package (artipod, yorm, @mieweb/ui) can adopt it. Exits 1 when a weight
// limit is exceeded; always writes weighbridge-report.json and, in GitHub
// Actions, a job-summary table.
//
// Usage: node weighbridge.mjs [--config weighbridge.json] [--write-baseline]

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, appendFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const argVal = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : dflt;
};
const configPath = resolve(argVal('--config', 'weighbridge.json'));
const writeBaseline = args.includes('--write-baseline');

const config = JSON.parse(readFileSync(configPath, 'utf8'));
const results = []; // { metric, value, budget, unit, ok, note }
const fmt = (bytes) => bytes >= 1024 * 1024 ? `${(bytes / 1048576).toFixed(2)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
const record = (metric, value, budget, unit, note = '') => {
  const ok = budget == null || value <= budget;
  results.push({ metric, value, budget: budget ?? null, unit, ok, note });
  const show = unit === 'bytes' ? fmt(value) : `${value.toFixed(0)} ${unit}`;
  const cap = budget == null ? '' : ` (limit ${unit === 'bytes' ? fmt(budget) : budget + ' ' + unit})`;
  console.log(`${ok ? 'ok  ' : 'OVER'} ${metric}: ${show}${cap}${note ? ` — ${note}` : ''}`);
};

// ---- 1. npm pack size (shipping weight) --------------------------------------
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

// ---- 2. bundle size per entry (esbuild min + gzip) --------------------------
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

// ---- 3. import time + RSS per entry (fresh node process, median of 3) -------
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

// ---- 4. command startup (e.g. CLI --help) -----------------------------------
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

// ---- report -----------------------------------------------------------------
const baselinePath = resolve('weighbridge-baseline.json');
const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : null;
const report = { date: new Date().toISOString(), results };
writeFileSync('weighbridge-report.json', JSON.stringify(report, null, 2) + '\n');
if (writeBaseline) writeFileSync(baselinePath, JSON.stringify(report, null, 2) + '\n');

if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = results.map((r) => {
    const base = baseline?.results.find((b) => b.metric === r.metric);
    const delta = base && Number.isFinite(r.value) ? r.value - base.value : null;
    const show = (v) => r.unit === 'bytes' ? fmt(v) : `${v.toFixed(0)} ms`;
    return `| ${r.ok ? '✅' : '❌'} | ${r.metric} | ${Number.isFinite(r.value) ? show(r.value) : 'error'} | ${r.budget == null ? '—' : show(r.budget)} | ${delta == null ? '—' : (delta >= 0 ? '+' : '') + show(delta)} | ${r.note} |`;
  });
  appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `## Weighbridge — curb weight\n\n| | metric | value | limit | Δ baseline | note |\n|---|---|---|---|---|---|\n${rows.join('\n')}\n`);
}

const failures = results.filter((r) => !r.ok);
if (failures.length) {
  console.error(`\n${failures.length} weight limit(s) exceeded. Either shrink the change or consciously raise the limit in ${configPath}.`);
  process.exit(1);
}
console.log('\nAll weight limits met — cleared to ship.');

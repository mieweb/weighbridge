import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tempDirs = [];

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'weighbridge-vite-'));
  tempDirs.push(dir);
  mkdirSync(join(dir, 'dist/.vite'), { recursive: true });
  return dir;
}

function writeConfig(dir, config) {
  writeFileSync(join(dir, 'weighbridge.json'), JSON.stringify(config));
}

function run(dir) {
  return spawnSync(process.execPath, [join(root, 'weighbridge.mjs')], {
    cwd: dir,
    encoding: 'utf8',
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('weighs shell and static route chunks, excluding dynamic imports', () => {
  const dir = project();
  const files = {
    'assets/index.js': 'import "./shared.js";',
    'assets/shared.js': 'export const shared = 1;',
    'assets/clock.js': 'import "./shared.js"; import "./static.js";',
    'assets/static.js': 'export const staticDependency = "included";',
    'assets/editor.js': `export const editor = "${'lazy'.repeat(10000)}";`,
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, 'dist', path)), { recursive: true });
    writeFileSync(join(dir, 'dist', path), content);
  }
  const manifest = {
    'index.html': { file: 'assets/index.js', isEntry: true, imports: ['_shared.js'], dynamicImports: ['src/features/clock/ClockPage.tsx'] },
    '_shared.js': { file: 'assets/shared.js' },
    'src/features/clock/ClockPage.tsx': { file: 'assets/clock.js', imports: ['_shared.js', '_static.js'], dynamicImports: ['src/features/editor/Editor.tsx'] },
    '_static.js': { file: 'assets/static.js' },
    'src/features/editor/Editor.tsx': { file: 'assets/editor.js' },
  };
  writeFileSync(join(dir, 'dist/.vite/manifest.json'), JSON.stringify(manifest));
  const expectedShell = gzipSync(files['assets/index.js']).length + gzipSync(files['assets/shared.js']).length;
  const expectedRoute = gzipSync(files['assets/clock.js']).length + gzipSync(files['assets/static.js']).length;
  writeConfig(dir, {
    vite: {
      shell: { maxGzipBytes: expectedShell },
      routes: [{ name: 'clock', source: 'src/features/clock/ClockPage.tsx', maxGzipBytes: expectedRoute }],
    },
  });

  const result = run(dir);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /app shell gzip:/);
  assert.match(result.stdout, /route clock gzip:/);
  const report = JSON.parse(readFileSync(join(dir, 'weighbridge-report.json'), 'utf8'));
  assert.deepEqual(report.results.map((row) => row.metric), ['app shell gzip', 'route clock gzip']);
  assert.equal(report.results[1].value, expectedRoute);
});

test('fails with the missing manifest path', () => {
  const dir = project();
  writeConfig(dir, { vite: { manifest: 'build/manifest.json', routes: [] } });

  const result = run(dir);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Vite manifest not found: .*build\/manifest\.json/);
});

test('fails with an unknown route source', () => {
  const dir = project();
  writeFileSync(join(dir, 'dist/index.js'), 'export {};');
  writeFileSync(join(dir, 'dist/.vite/manifest.json'), JSON.stringify({
    'index.html': { file: 'index.js', isEntry: true },
  }));
  writeConfig(dir, { vite: { routes: [{ name: 'clock', source: 'src/renamed.tsx' }] } });

  const result = run(dir);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Vite route source not found in manifest: src\/renamed\.tsx/);
});

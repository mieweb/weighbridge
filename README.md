# weighbridge

**The scale your npm package crosses before it ships.**

Every package your users install has a *curb weight* — what their app carries before it loads any cargo of its own: the tarball on disk, the bytes their bundler ships to browsers, the milliseconds and megabytes burned just `import`ing you. Nobody adds 400 KB on purpose. It arrives one "small" dependency and one "temporary" re-export at a time, and by the time someone opens an issue about it, it's load-bearing.

weighbridge is a CI gate that weighs your package on every PR and refuses to let an overweight load leave the yard.

```text
ok   pack tarball: 4.13 MB (limit 4.77 MB)
ok   bundle . gzip: 594.2 KB (limit 654.3 KB) — min 1.99 MB
ok   bundle ./tools gzip: 12.4 KB (limit 15.6 KB) — min 39.9 KB
ok   import .: 101 ms (limit 700 ms) — rss 97.44 MB (report-only)
ok   cmd cli --help: 127 ms (limit 800 ms)

All weight limits met — cleared to ship.
```

## What it weighs

| Measurement | How | Catches |
|---|---|---|
| **Shipping weight** — tarball, unpacked size, per-directory sections | `npm pack --dry-run` | Accidentally published assets, doc/type bloat, a demo UI riding along in `files` |
| **Curb weight** — min+gzip bundle per export entry | esbuild (pinned version), your externals | A dependency that doubles what every browser app ships |
| **Cold start** — fresh-process `import()` time (median of 3) + RSS | plain `node` child processes | A lazy import someone made eager; module-graph creep |
| **CLI startup** — any command you name | timed spawn | Slow `--help`, slow `npx yourtool` first impressions |

One zero-dependency Node script. No framework, no config DSL — a JSON file of limits.

## Adopt it in three steps

**1. Add `weighbridge.json`** next to your `package.json` — your export entries, your weight limits (current measurement + ~10% headroom is a good start):

```jsonc
{
  "esbuild": { "version": "0.25.0", "platform": "browser", "external": ["react", "react-dom"] },
  "pack": {
    "maxTarballBytes": 5000000,
    "sections": { "dist": { "prefix": "dist/", "maxBytes": 3300000 } }
  },
  "entries": [
    { "name": ".",       "path": "dist/index.js",       "maxGzipBytes": 670000, "maxImportMs": 700 },
    { "name": "./tools", "path": "dist/tools/index.js", "maxGzipBytes": 16000,  "maxImportMs": 150 }
  ],
  "commands": [
    { "name": "cli --help", "command": ["node", "dist/cli.js", "--help"], "maxMs": 800 }
  ]
}
```

**2. Add the action** to your CI after install + build:

```yaml
- uses: mieweb/weighbridge@v1
```

**3. Run it locally** whenever you're curious:

```bash
npx github:mieweb/weighbridge
```

Over a limit? The job fails with exactly which metric and by how much. Either shrink the change — or raise the limit *in the same PR*, where a reviewer sees the weight increase as a conscious, diffable decision instead of silent drift.

## Weighing a Vite app

Vite builds can be weighed from their build manifest, without re-bundling or configuring hashed output filenames. Enable the manifest in Vite:

```js
export default {
  build: { manifest: true },
};
```

Then add a `vite` section to `weighbridge.json`:

```json
{
  "vite": {
    "manifest": "dist/.vite/manifest.json",
    "dist": "dist",
    "shell": { "maxGzipBytes": 260000 },
    "routes": [
      {
        "name": "clock",
        "source": "src/features/clock/ClockPage.tsx",
        "maxGzipBytes": 200000
      }
    ]
  }
}
```

`source` is the route's source-path key in the manifest, not its hashed output filename. The `app shell gzip` row includes each `isEntry` chunk and its static imports once. Each `route <name> gzip` row measures only that route's static chunks beyond the shell. Lazy `dynamicImports` are not followed, so moving code behind `import()` does not increase startup weight. Files are gzipped as Vite built them; no esbuild configuration is needed for this mode. As with other measurements, omit a limit to make a row report-only. A missing manifest or source key fails with a message naming the missing path.

## See the trend, not just the number

**In every PR** — the [reference workflow](examples/workflow.yml) posts a sticky comment (updated in place on each push) showing what the PR does to the overall trajectory: a sparkline of recent main-branch weigh-ins with *this PR appended as the would-be next point* (●), the Δ against main, and how much headroom is left before the limit blocks someone:

> | | metric | trend | value | Δ main | limit | headroom |
> |---|---|---|---|---|---|---|
> | ✅ | bundle . gzip | `▃▃▄▄▅▅▆` ● | 601 KB | +7.2 KB | 654 KB | 92% |
> | ✅ | bundle ./tools gzip | `▁▁▁▁▁▁▁` ● | 12.4 KB | ±0 | 15.6 KB | 79% |

A +7 KB bump on a flat line reads very differently from +7 KB on a staircase.

**In your terminal** — sparkline history straight from the weigh-ins branch (repo auto-detected from your git remote):

```text
$ npx github:mieweb/weighbridge trend
weighbridge trend — 12 weigh-ins (0.10.0 → 58f5dff)

bundle . gzip        ▃▃▄▄▅▅▆▇█  551.1 KB → 594.2 KB  (+7.8%)
bundle ./tools gzip  ▁▁▁▁▁▁▁▁▁  12.4 KB → 12.4 KB  (steady)
pack tarball         ▂▂▂▂▂▂▇██  408.1 KB → 4.13 MB  (+937%)
```

Flags: `--releases` (release rows only), `--last N`, `--metric <substring>`, `--repo owner/repo`.

**In your README** — the workflow refreshes shields.io endpoint badges on the weigh-ins branch on every main push (green under 80% of limit, yellow near, red over):

```markdown
![curb weight](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/OWNER/REPO/weigh-ins/badge.json)
```

Per-metric badges are written too (`badge-bundle-tools-gzip.json`, …).

**On every release** — a “weigh ticket” is stamped into the release notes: each metric, its value, and Δ vs the previous release. Every release page permanently documents what that version weighs.

## Trending: PRs, main, and releases

The [reference workflow](examples/workflow.yml) adds history on top of the gate:

- **Every PR** gets a job-summary table with a **Δ-vs-main column** per metric (the latest main run's report is fetched as the baseline) — reviewers see "+3.2 KB gzip on `./tools`" right in the check, before merge.
- **Every main push and release** appends one weigh-in row to `weigh-ins.jsonl` on a dedicated **`weigh-ins` branch** — permanent, diffable history (workflow artifacts expire after 90 days; a branch doesn't). Release rows carry the tag, so version-over-version trends are a one-liner:

```bash
git show origin/weigh-ins:weigh-ins.jsonl \
  | jq -r 'select(.event=="release") | [.ref, .metrics["pack tarball"], .metrics["bundle . gzip"]] | @tsv'
```

## Config reference

| Key | Meaning |
|---|---|
| `esbuild.version` | Pinned esbuild version (reproducible weigh-ins) |
| `esbuild.platform` / `esbuild.external` | Global bundling defaults; also settable per entry |
| `pack.maxTarballBytes` / `pack.maxUnpackedBytes` | Limits on `npm pack` output |
| `pack.sections.<name>` | `{ prefix, maxBytes? }` — per-directory shipping weight (e.g. gate `dist/` tightly while a bundled UI is only reported) |
| `entries[]` | `{ name, path, maxGzipBytes?, maxImportMs?, platform?, external? }` — omit a limit to skip that measurement |
| `vite` | `{ manifest?, dist?, shell?, routes[] }` — Vite build-manifest startup weights |
| `commands[]` | `{ name, command: [argv...], maxMs }` |

Flags: `--config <path>` (default `weighbridge.json`), `--write-baseline` (snapshot current numbers into `weighbridge-baseline.json` for local Δ comparison).

Subcommands: `trend`, `badges`, `ticket` — see `weighbridge.mjs` header for flags. The gate auto-detects `weighbridge-baseline.json` (Δ column) and `weigh-ins.jsonl` (trend column) in the cwd and writes `weighbridge-summary.md` (the PR-comment/job-summary markdown) alongside the report.

Any metric without a limit is **report-only** — measured, tabled, trended, never failing. RSS after import is always report-only (too runner-noisy to gate).

## Notes

- Runs **after** your build; it weighs `dist/`, not `src/`.
- Time limits should be generous (2–3× your laptop): CI runners are slow and shared. The gzip numbers are deterministic — make those the tight ones.
- `npm pack --dry-run` triggers your `prepare` script (typically a rebuild) — harmless in CI where you just built, a few extra seconds locally.
- The gate itself needs no permissions. The trending extras in the [reference workflow](examples/workflow.yml) need `contents: write` (weigh-ins branch + badges), `actions: read` (PR baseline), and `pull-requests: write` (sticky comment).
- Add `weighbridge-report.json`, `weighbridge-baseline.json`, `weighbridge-summary.md`, and `weigh-ins.jsonl` to your `.gitignore`.

---

*Know the weight of your empty container — and never let it grow by accident.*

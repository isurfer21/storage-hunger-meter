# 🍽️ Hunger Meter

An offline-first filesystem scanner that measures **storage hunger** — how aggressively directories consume disk space over time. Built with pure TypeScript (Bun), zero external runtime dependencies, and a no-framework SPA dashboard.

---

## Table of Contents

- [Installation](#installation)
  - [CLI binary (global)](#cli-binary-global)
  - [Local project](#local-project)
- [Usage](#usage)
  - [CLI Mode](#cli-mode)
  - [Web Dashboard](#web-dashboard)
  - [Package Scripts](#package-scripts)
- [Architecture](#architecture)
  - [Data Flow](#data-flow)
  - [Module Map](#module-map)
  - [Scan Engine](#scan-engine)
- [Metrics & Scoring](#metrics--scoring)
  - [Raw Metrics (14 signals)](#raw-metrics-14-signals)
  - [Growth Patterns (7 detectors)](#growth-patterns-7-detectors)
  - [Hunger Score (0–100)](#hunger-score-0100)
- [Types](#types)
- [CLI Defaults](#cli-defaults)

---

## Installation

Prerequisites: **[Bun ≥ v1.1](https://bun.com)** installed and in `$PATH`.

### CLI binary (global)

```bash
cd ~/projects/hunger-meter   # this repo
bun link                     # registers "hunger-meter" to /usr/local/bin
```

Thereafter, call it from anywhere:

```bash
hunger-meter --help
hunger-meter -e /opt/local --depth 8
hunger-meter --mode web
```

### Local project

```bash
bun install
bun run index.ts [OPTIONS]   # or "bun scan", "bun web" (see scripts below)
```

---

## Usage

### CLI Mode

Outputs a formatted table to `stdout` with ANSI color-coding: green (< 25), cyan (25–49), yellow (50–74), red (> 75).

```bash
# Default — scan $HOME at depth 5, show top-10
$ hunger-meter

# Scan a specific directory, deeper traversal
$ hunger-meter -e ~/Documents --depth 8

# Show top-25 eaters
$ hunger-meter -e /opt/local --top 25

# Combined: deep scan + wider ranking
$ hunger-meter -e ~/projects --depth 10 --top 40

# Re-scan with custom depth and top-N from source tree
$ bun run index.ts -e . --depth 6 --top 30
```

### Web Dashboard

Starts a local HTTP server (`Bun.serve`) serving an embedded SPA that displays:

| Panel | Content |
|---|---|
| **A** — Hunger Score | Horizontal bars for each directory, color-coded |
| **B** — Fill Rate | MB/day growth rate per dir (blue bars) |
| **C** — Metrics Detail | Per-directory raw metrics view |
| **D** — Summary Table | Ranked list of all scanned directories with size, hunger score, rate |

Sidebar shows sibling breakdowns for each parent directory.

```bash
# Dashboard on default port 3000
$ hunger-meter --mode web

# Custom port
$ hunger-meter -e /tmp --mode web --port 8080
```

After the dashboard loads at `http://localhost:3000`, type any path into the input field and click **▶ Scan** to re-run the scan (the server-side scan runs synchronously; no polling required).

### Package Scripts

| Script | Command |
|---|---|
| `bun start` | Watch-reload mode (`--watch`) for development |
| `bun scan` | CLI table output (same as `index.ts --mode cli`) |
| `bun web` | Web dashboard server |
| `bun check` | TypeScript type-check (`tsc --noEmit`) |

---

## Architecture

### Data Flow

```
┌──────────────┐     ┌───────────────┐     ┌──────────────────┐     ┌──────────────┐
│  Scanner     │────▶│   Metrics     │────▶│   Scoring &      │────▶│  Renderer   │
│  (scanner)   │     │   Engine      │     │   Pattern        │     │  (CLI / Web)│
│              │◀────│  (metrics.ts) │     │    Detection     │     │  (index.ts) │
│ BFS walk +   │     │ Per-dir       │     │                  │     │              │
│ statSync()   │     │ aggregation   │     │ 14 raw metrics   │     │ ANSI tables / │
└──────────────┘     └───────────────┘     │ + 7 pattern      │◀────│  SPA HTML   │
                                            │   detectors       │      embedded    │
                                            └──────────────────┘     └──────────────┘
```

1. **Parse** CLI args (entry, depth, top-N, mode, port) → resolve to absolute path.
2. **BFS scan** every directory/file up to `maxDepth`, yielding one `LayerResult` per level. Symlinks are always skipped; inaccessible paths are silently dropped. An entry-count guard (`10_000_000`) prevents runaway walks.
3. **Group** files by their parent directory across all layers.
4. **Compute** 14 raw metrics per parent dir, aggregate into a DirSummary.
5. **Score & classify** — run the composite hunger score (0–100) and detect up to 7 growth patterns.
6. **Format** — render as ANSI table or serve embedded SPA at `http://localhost`.

### Module Map

| File | Purpose | Lines |
|---|---|---|
| `index.ts` | Entry point, arg parsing, scan pipeline, CLI formatter, embedded SPA + web server | ~350 |
| `scanner.ts` | BFS walker (`bfsWalk()` generator) — read-only fs traversal per BFS queue-level | ~100 |
| `metrics.ts` | 14 metrics (M1–M14), scoring engine, pattern detectors, sibling fraction post-pass; helpers: `computeMetrics`, `buildRankings`, `buildLayerBreakdowns`, `formatSize`, `rankEmoji`, `buildGlobalStats` | ~295 |
| `types.ts` | All shared TypeScript interfaces (FileSystemNode, LayerResult, DirSummary, GlobalStats, TableRow, etc.) | ~160 |

### Scan Engine

The scanner is a **generator** (`bfsWalk`) that yields `LayerResult[]` level by level:

```
Layer 0 (root):  /Users/ab → [dir node + all immediate children]
Layer 1 (depth 1): each sub-directory's children
Layer 2 … N:     …
```

Each `FileSystemNode` carries `path`, `sizeBytes`, `mtimeMs`, `birthtimeMs`, `depth`, and `layer`. The same `visited` set deduplicates across all layers — no node is ever processed twice.

---

## Metrics & Scoring

### Raw Metrics (14 signals)

Each metric operates per parent directory and its owned files:

| ID | Name | What it measures | Range |
|---|---|---|---|
| **M1** | `mtimeFillRateMBd` | How fast files are being written-to (active churn) | MB/day |
| **M2** | `birthGateRateMBd` | New-file creation rate, decayed for files older than 30 days | MB/day |
| **M3** | `compositeRateMBd` | Weighted blend: M1 × 0.6 + M2 × 0.4 | MB/day |
| **M4** | `ageDeltaDays` | Parent dir age minus average child birth age (detects dormancy-then-population) | days |
| **M5** | `c2sRatioMBd` | Creation-to-size ratio: bytes created per day since parent ctime | MB/day |
| **M6** | `birthEntropy` | Std-dev of file birth times — a measure of burstiness vs. gradual accumulation | seconds |
| **M7** | `cohortTrendSlopeMBpm` | Linear regression slope on cohort (daily bytes created), R² for trend fit | MB/month |
| **M8** | `depthConcentration` | How shallow files sit — high value = visible near parent; low = buried deep | 0–1 |
| **M9** | `siblingFraction` | This dir's total size / sum of all sibling dirs under the same parent | 0–1 |
| **M10** | `countToSizeDivergence` | Avg file size / median file size — >1 means skewed toward outliers | float |
| **M11** | `inodeRisk` | Fraction of files < 1 KB — high % = inode exhaustion danger | 0–1 |
| **M13** | `extensionMap` | File-count and byte distribution by extension (e.g., `{".ts": {count:42, bytes:1085}}`) | map |
| **M14** | `agePyramid` | File sizes distributed across age buckets: 0-7d, 8-30d, 31-90d, 91-365d, 365+d | map |

### Growth Patterns (7 detectors)

| Pattern | Condition (simplified) | What it signals |
|---|---|---|
| `burst_creator` | Birth rate > 3× mtime rate AND birth rate > 10 MB/d | Files are being created but never touched again |
| `late_populator` | Parent died for >90 days then suddenly got children | Dormant dir was reactivated |
| `iceberg` | Depth conc < 0.2 AND total size > 1 GB | Huge footprint hidden deep below |
| `linear_growth` | Cohort regression R² > 0.8 with positive slope | Steady, predictable growth |
| `exponential_growth` | Cohort slope > 2× mtime fill rate; cohort R² > 0.6 | Accelerating write pressure |
| `stable_plateau` | Extension-byte CV < 30% AND total size > 10 MB | Established, stable codebase/content dir |
| `erratic` | >60% of files < 1 KB AND >50 files | Fragmented writes — inode safety risk |

### Hunger Score (0–100)

Composite score combining six weighted components into a single 0–100 number. Higher = hungrier dir deserving cleanup attention.

| Component | Weight | Description |
|---|---|---|
| Fill rate (normed) | **30 %** | How aggressively the dir is growing relative to its own max rate |
| Trend slope | **25 %** | Cohort regression slope as fraction of max observed fill rate |
| Sibling imbalance | **5 %** | Does this dir hoard a disproportionate share of parent resources? |
| Iceberg penalty | **10 %** | Hidden deep below — penalised for total size > 1 GB with low conc |
| Inode safety | **5 %** | Risk from small-file fragmentation |
| Birth rate pulse | **25 %** | How much of the growth is fresh creation vs. modification |

**Default weights** are tuned to favour recent write-pressure (fill + composition = 55 %) over stability signals, since a hungry system is usually one that's actively accumulating data.

---

## Types

All shared types live in `types.ts`:

- `FileSystemNode` — raw node from `readdirSync` + `statSync`
- `LayerResult` — what the scanner yields per BFS level
- `DirSummary` — fully computed metrics for one parent directory
- `FileGrowthPattern` — detected growth behaviour (type, confidence, description)
- `GlobalStats` — scan-level summary (bytes scanned, dirs, duration, system hunger index)
- `TableRow` / `LayerBreakdown` — formatted structures for CLI and web consumption

---

## CLI Defaults

| Flag | Default |
|---|---|
| `--entry / -e` | `$HOME` (your home directory) |
| `--depth` | `5` BFS max levels |
| `--top` | `10` top eaters to display |
| `--mode` | `cli` — ANSI table output |
| `--port` | `3000` (for `--mode web` only) |

```bash
# Every command below is a valid invocation:
hunger-meter                                          # default scan of $HOME
hunger-meter -e /opt/local                            # specific root, defaults otherwise
hunger-meter --entry ~/projects --depth 8 --top 25    # deep + wide ranking
hunger-meter --mode web                               # SPA dashboard on :3000
hunger-meter -e /tmp --mode web --port 9090           # custom port for dashboard
hunger-meter --help                                   # structured help with samples (exit 0)
```

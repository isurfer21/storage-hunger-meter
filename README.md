# 🍽️ Storage Hunger Meter

> **Predictive filesystem storage-eater analysis — ranked by statistical hunger, not just size.**

Storage Hunger Meter is a read-only disk analytics tool built with [Bun](https://bun.sh). It scans any directory tree layer-by-layer using breadth-first search, computes fourteen distinct filesystem-metrsic features per directory, and ranks every directory by how aggressively it consumes storage over time.

It's not `du -sh` sorted alphabetically — it **predicts** which directories will run out of space next based on growth rate, burst events, depth patterns, and cohort trends.

<div align="center">

|            CLI Mode             |     Web Dashboard (via `--mode web`)     |
|:-------------------------------:|:----------------------------------------:|
| Fast table output over `stdout` | Interactive SPA with charts & breakdowns |

</div>

---

## ✨ Features

- **14 statistical metrics** — fill rate, cohort regression, age delta, depth concentration, sibling imbalance, inode risk, extension profiles, birth-gate analysis, and more.
- **Dual output modes** — terminal table (`--mode cli`, default) or live web dashboard (`--mode web`).
- **Zero external dependencies** — pure Bun + Node stdlib (`fs`, `os`, `path`). No npm packages are required at runtime.
- **BFS layer-by-layer traversal** — memory scales with the widest single layer, not the entire tree. Symlink-safe, deduped across all layers, with a configurable depth cap and entry-count safety valve.
- **Glob-level accurate totals** — uses `Bun.Glob` for correct subtree size computation (recursive du-equivalent) instead of relying on inaccurate directory stat metadata.
- **Pattern detection** — auto-classifies directories as `burst_creator`, `late_populator`, `iceberg`, `linear_growth`, `exponential_growth`, `stable_plateau`, or `erratic`.
- **Compositely weighted hunger score (0–100)** — normalized, configurable-weight blend of all metrics tuned to surface the most dangerous directories first.

---

## 📦 Installation

Requires **[Bun](https://bun.sh)** >= 1.0.

```bash
# Clone or download this repo
git clone https://github.com/your-username/hunger-meter.git
cd hunger-meter

# Bun will resolve the local peerDependency (typescript types) automatically
bun install
```

---

## 🚀 Quick Start

### Scan your home directory (default)

A quick default scan of `$HOME` at depth 5 with top-10 results:

```bash
bun run index.ts
# or
bun run scan          # alias script
```

### Custom directory, depth & ranking width

```bash
bun run index.ts -e /opt/local --depth 8 --top 25
```

### Web dashboard mode

Spins up a local HTTP server and opens an interactive SPA:

```bash
bun run index.ts --mode web              # default port 3000
bun run web   # alias script             # same thing
```

Navigate to **http://localhost:3000** in your browser. The dashboard shows hunger bars, fill-rate charts, layer breakdowns, and a full directory ranking table. You can type any new path into the top-bar input and press **▶ Scan** to re-scan without reloading the page.

### Watch Mode (development)

```bash
bun run start   # runs with —watch for hot-reload during development
```

---

## 🔧 CLI Reference

| Flag / Option            | Default                                                               | Description                                                 |
|:------------------------:|:---------------------------------------------------------------------:|-------------------------------------------------------------|
| `--entry`, `-e` `<path>` | `$HOME`                                                               | Root directory to scan (absolute, relative or `~`-expanded) |
| `--depth` `<n>`          | `5`                                                                   | Maximum BFS traversal depth                                 |
| `--top` `<n>`            | `10`                                                                  | Top-N directories shown in output tables                    |
| `--mode` `cli`\|\`web`   | `cli`                                                                 | Output subsystem: terminal table or HTTP dashboard server   |
| `--port` `<n>`           | `3000`                                                                | Port for web mode (ignored in CLI mode)                     |
| `--columns` `<list>`     | `Fill Rate,Trend Slope,Birth Gate,Sibling Imb,Iceberg Pen,Inode Risk` | Comma-separated subset of extra columns to display          |
| `-h`, `--help`           | —                                                                     | Show help menu and exit                                     |

### Sample commands

```bash
# Quick scan of ~/Documents
bun run index.ts -e ~/Documents

# Deep scan of a NAS volume, rank top 50
bun run index.ts --entry /Volumes/Data/projects --depth 8 --top 50

# Web dashboard on a custom port
bun run index.ts --mode web --port 8085

# Only show specific columns in the table
bun run index.ts --columns "Fill Rate,Birth Gate"

# Explicit CLI alias (uses package.json script)
bun run scan
```

---

## 🧠 The Metrics Engine

Every scanned directory accumulates the following metrics. Together they describe *how* that directory is growing and what kind of storage threat it represents.

|    #    | Name                         |       Type        | Description                                                                                                                                      |
|:-------:|:-----------------------------|:-----------------:|:-------------------------------------------------------------------------------------------------------------------------------------------------|
| **M1**  | Mtime Fill Rate              |       Speed       | Active write speed (`MB/day`) derived from file modification times. High values → files are still being written to regularly.                    |
| **M2**  | Birth-Gate Rate              |       Speed       | Burst-aware fill rate using file creation timestamps. Catches sudden bulk ingestion (clones, downloads).                                         |
| **M3**  | Composite Fill Rate          |       Speed       | `M1 × 0.6 + M2 × 0.4`. The primary blended signal for current consumption.                                                                       |
| **M4**  | Dir-vs-File Age Delta        |      Timing       | Parent-directory age minus children's average birth age. Positive delta → late-populator pattern.                                                |
| **M5**  | Creation-to-Size Ratio       |       Rate        | Directory-size divided by days-since-creation (`MB/day`). High values → rapid accumulation.                                                      |
| **M6**  | Birth Entropy                |    Dispersion     | Standard deviation of children's birth times. Low entropy → single burst; high entropy → sustained / sporadic growth.                            |
| **M7**  | Cohort Trend Analysis        |    Regression     | Monthly cohort regression (slope + R²). Predicts whether the directory is growing linearly, exponentially, or stably.                            |
| **M8**  | Depth Concentration          |   Distribution    | What fraction of a directory's bytes sit in visible vs buried subdirectories (`0–1`). Low values → "iceberg" directories.                        |
| **M9**  | Sibling Imbalance            |    Statistical    | Largest sibling / total-parent-size. Identifies outlier dirs that dominate their parent layer.                                                   |
| **M10** | Count-to-Size Divergence     |   Distribution    | Average file size divided by median. Divergence > 1 → few massive files; << 1 → many tiny files.                                                 |
| **M11** | Inode Risk Index             |       Risk        | Fraction of files under 1 KB. High risk → inode depletion even if free bytes remain.                                                             |
| **M12** | Temporal Activity Clustering | Rhythm *(future)* | Hourly / daily write maps to distinguish human vs automated growth patterns.                                                                     |
| **M13** | Extension Dominance          |      Profile      | Top file extensions by total bytes — tells you *what* is growing.                                                                                |
| **M14** | Age Pyramid                  |   Distribution    | Bytes distributed across age buckets (`0-7d`, `8-30d`, `31-90d`, `91-365d`, `365+d`). Top-heavy → newly active; bottom-heavy → cache stagnation. |

### Hunger Score Formula (0–100)

```
hungerScore = w₁·M1_norm + w₂·M2_norm + w₃·trendSlope_norm
            + w₄·siblingImbalance + w₅·icebergPenalty + w₆·inodeRisk
```

|   Weight    | Component                        | Default | Reasoning                                                  |
|:-----------:|:---------------------------------|:-------:|:-----------------------------------------------------------|
| `w₁ = 0.25` | mtime fill rate                  |  0.25   | Most direct signal: actively eating *now*.                 |
| `w₂ = 0.30` | composite fill rate (birth-gate) |  0.30   | Burst patterns cause the most surprise space-loss events.  |
| `w₃ = 0.25` | cohort trend slope               |  0.25   | Looking *forward* — growth trajectory is key.              |
| `w₄ = 0.05` | sibling imbalance                |  0.05   | Contextual; only notable per parent layer.                 |
| `w₅ = 0.10` | iceberg penalty                  |  0.10   | Hidden depth risk matters even when the dir "looks" small. |
| `w₆ = 0.05` | inode safety margin              |  0.05   | Inode exhaustion is invisible until it's too late.         |

#### Score Tiers

| Range  | Color  | Meaning  | Action                                               |
|:------:|:------:|:---------|:-----------------------------------------------------|
|  0–25  |   🟢   | Safe     | No alert; directory at equilibrium.                  |
| 26–50  |   🟡   | Watch    | Surface in top-10 if ≥3 data cohorts exist.          |
| 51–75  |   🟠   | Monitor  | Warn the user; show predicted days-until-full.       |
| 76–100 |   🔴   | Critical | Primary clean-up candidate — highlight aggressively. |

### Automatically Detected Patterns

Hunger Meter attaches a `FileGrowthPattern[]` array to every directory:

| Pattern                | Trigger Condition                                  | Confidence                           |
|:-----------------------|:---------------------------------------------------|:-------------------------------------|
| **burst_creator**      | Birth gate rate > 3× mtime rate AND > 10 MB/d      | Clamped by birth-to-mtime ratio      |
| **late_populator**     | Dir is > 90 days older than its children           | `deltaDays / 365`                    |
| **iceberg**            | Total size > 1 GB and depth concentration < 0.2    | Weighted by how buried the bytes are |
| **linear_growth**      | Cohort regression slope > 0 with R² > 0.8          | = R² value                           |
| **exponential_growth** | Cohort slope exceeds mtime rate by ≥ 2× (R² > 0.6) | Ratio-based clamped to [0, 1]        |
| **stable_plateau**     | Extension cohort CV < 30% + total size > 10 MB     | Inverse of coefficient of variation  |
| **erratic**            | inodeRisk > 0.6 AND fileCount > 50                 | = inodeRisk value                    |

---

## 📂 Project Structure

```
hunger-meter/
├── index.ts          # Entry point — arg parsing, scan pipeline orchestration, mode dispatch (CLI / Web)
├── scanner.ts        # BFS layer-by-layer filesystem walker — symlink skip, dedup, generator-based streaming
├── metrics.ts        # All 14 metric computations, scoring, pattern detection, helper functions & API
├── types.ts          # Shared TypeScript interfaces (FileSystemNode, DirSummary, MetricsConfig, etc.)
├── web/
│   ├── index.html    # SPA dashboard shell (panels, stats bar, scan input)
│   ├── app.js        # Client-side rendering logic — bars, tables, data-grid population, fetch to /api/*
│   └── css/
│       └── styles.css # Catppuccin Mocha–inspired dark theme, bar layouts, panel grid, responsive
├── docs/
│   ├── ARCHITECTURE.md  # Full data-flow diagrams, component contracts, future SSE/Watch scaffolding
│   ├── METRICS.md       # Extended metrics reference (all 14 dimensions, formulae, threshold tables)
│   └── PLAN.md          # Development plan, milestones M1–M5, scanning model details
├── graphify-out/    # Auto-generated knowledge-graph output (AST-level cross-file map)
├── package.json     # Scripts: start / scan / web / check
├── tsconfig.json    # Strict TS config — bun module resolution, noEmit, ESNext target
└── LICENSE          # MIT (c) 2023 Abhishek Kumar
```

---

## 🔌 API & Architecture

### Data Flow

```
┌───────────────────────────── Input ──────────────────────────────┐
│ CLI args (--entry --depth --mode --port)                         │
│ Web UI text input ── POST /api/restart ──────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────┐
│  index.ts  —  parseArgs() → validate & resolve entry path    │
│             → dispatchScan(mode)                             │
└───┬──────────────────────────┬───────────────────────────────┘
    │ CLI                      │ Web Server (Bun.serve)
    ▼                          ▼
┌───────────────┐      ┌──────────────────────────────────────┐
│ bun:cli       │      │ GET /          → SPA HTML            │
│  ·renderCLI   │      │ GET /api/data   → initial scan JSON  │
│  ·stdout table│      │ POST/ api/restart → re-scan JSON     │
└──────┬────────┘      │ /css/*, /app.js   → static assets    │
       │               └───────────────┬───────────┬──────────┘
       │                               │           │  (same core)
       ▼                               ▼           ▼
┌──────────────────────────────────────────────────────────────────┐
│                  Pure Processing Pipeline                        │
│                  ← shared by CLI & Web →                         │
│                                                                  │
│   scanner.ts ──bfsWalk()──→ DirSummary[] (ranked)                │
│     · BFS with depth cap                                         │
│     · Symlink-safe, dedup across layers                          │
│     · Generator-streamed for memory efficiency                   │
│                                                                  │
│   metrics.ts ──computeMetrics()──→ DirSummary[] + GlobalStats    │
│     · All 14 metric calculations                                 │
│     · Weighted hunger-score (0-100)                              │
│     · Pattern classification                                     │
│     · Sibling imbalance post-processing                          │
│                                                                  │
│   index.ts ──dirSize() / dirFilesRecursive()                     │
│     · Bun.Glob accurate subtree sizes (du -ks equivalent)        │
│     · Override scanner totals with correct glob-discovered data  │
└──────────────────────────────────────────────────────────────────┘
```

### Web Server Endpoints

| Endpoint          | Method | Description                                                                                  |
|:------------------|:------:|:---------------------------------------------------------------------------------------------|
| `/`               |  GET   | Serves the SPA dashboard (`web/index.html`)                                                  |
| `/api/data`       |  GET   | Returns a fresh `DashboardData` JSON snapshot (auto-rebuilds on every call)                  |
| `/api/restart`    |  POST  | Accepts `{ entryPath, maxDepth }`, re-runs the full BFS + metrics pipeline, returns new data |
| `/css/styles.css` |  GET   | Static-serve web CSS                                                                         |
| `/app.js`         |  GET   | Static-serve web JS                                                                          |

### `DashboardData` JSON Schema

```typescript
interface DashboardData {
  globalStats: {
    totalBytesScanned: number;        // accurate du-equivalent root total
    totalFiles: number;
    totalDirs: number;
    durationMs: number;               // wall-clock scan time
    systemHungerIndex: number;        // avg hunger score across all dirs (0-100)
    depthScanned: number;             // max BFS layer traversed
    entryPathResolved: string;         // resolved realpath
  };
  primaryRankings: TableRow[];          // top-N by total size, with contribution breakdown
  layerBreakdowns: LayerBreakdown[];    // sibling groupings grouped by parent directory
  selectedDirMetrics: DirSummary | null;// populated per user click (null on initial load)
  entryPath: string;                    // which path was scanned
}

interface TableRow {
  rank: number;           // #1, #2… ranked within top-N
  emoji: '🥇'\|'🥈'\|'🥉'\|#N;
  path: string;
  size: string;           // "24.3 GB" — human-readable
  fillRate: string;       // "+1.2 GB/d"
  hungerScore: number;    // 0-100 composite
  capturedPct?: string;   // % of root entry path captured
  contributions: {
    fillRateContribution: string;      // weighted score component
    trendSlopeContribution: string;
    birthGateContribution: string;
    siblingImbalanceContribution: string;
    icebergPenaltyContribution: string;
    inodeRiskContribution: string;
  }
}

interface LayerBreakdown {
  layerKey: string;        // e.g. "Layer1"
  parentPath: string;      // the parent directory containing these siblings
  totalSizeBytes: number;
  siblingCount: number;
  siblings: Array<{
    name: string;
    sizeStr: string;
    percentOfParent: number;   // % of parent's total
    fillRate: string;          // MB/d
    hungerScore: number;
    rank: number;
  }>;
}
```

---

## 🛡️ Safety Guarantees

| Guarantee                      | Enforcement                                                                                                                             |
|:-------------------------------|:----------------------------------------------------------------------------------------------------------------------------------------|
| **100% read-only**             | Only `fs.statSync`, `readdirSync` + `Bun.Glob.scanSync`. Zero write/delete APIs called anywhere.                                        |
| **Symlink-safe**               | Every directory entry checked via `lstat`; symbolic links are always skipped.                                                           |
| **Dedup-across-all-layers**    | A single `visited Set<string>` prevents infinite loops from bind mounts or symlink back-links.                                          |
| **OOM protection**             | Entry-count limit (`10_000_000` default) with early-exit warning if reached. BFS is generator-streamed (one layer in memory at a time). |
| **Graceful permission errors** | Unreadable directories/files are silently skipped during walk; stats totals still compute correctly via glob for accessible subtrees.   |

---

## ⚙️ Development & Scripts

```bash
# Type-check the codebase (runs tsc under the hood)
bun run check

# Start in watch mode for hot-reload during development
bun run start

# Run a one-shot CLI scan
bun run scan

# Launch the web dashboard
bun run web
```

### tsconfig Notes

- **Strict mode enabled** — all six strict-flag families active.
- **Module resolution**: `bundler` (matching Bun's module system).
- **ECMAScript modules** — `"type": "module"` in package.json, `.ts` extensions imported directly.
- **`noEmit: true`** — outputs are type-checked only; Bun runs `.ts` files at runtime with no build step needed.

---

## 🗺️ Roadmap (Planned Milestones)

| Phase     | Scope                                                                                              | Status          |
|:----------|:---------------------------------------------------------------------------------------------------|:----------------|
| **M1** ✅ | Core BFS scanner + M1 fill rate + CLI table output                                                 | Done            |
| **M2** ✅ | Birth-gate rate (M2), sibling layer breakdown, web UI skeleton (Bun HTTP server + SPA)             | Done            |
| **M3** ✅ | Advanced metrics (M4–M6 age delta / C2S / entropy), interactive dashboard charts, dual-mode parity | Done            |
| **M4** ⬚  | Continuous watch mode (interval-based re-scans) + SSE/WebSocket live-push to Web UI                | Not implemented |
| **M5** ⬚  | Alert thresholds + JSON report export + configurable score weights from CLI/UI                     | Not implemented |

---

## 🤝 Contributing

Contributions welcome. Please ensure:

1. Code is formatted with `bun check` passing (strict TypeScript).
2. Any new logic includes inline comments or doc-blocks.
3. No new npm dependencies are added without justification — use Bun / Node stdlib.

---

## 📄 License

MIT License (c) 2023 Abhishek Kumar. See [LICENSE](./LICENSE) for details.

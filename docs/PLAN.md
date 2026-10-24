# Hunger Meter — Storage Eater Analysis Plan

## Overview

**Hunger Meter** is a read-only filesystem analytics tool that scans directories layer-by-layer (BFS from `$HOME`) and ranks siblings by their "storage hunger" — how fast they consume disk space over time.

The core goal: **predict which directories will run out of space next**, based purely on statistical analysis of existing file metadata (no writes, no deletes).

---

## 0. Entry Point Configuration (Requirement 1)

The tool accepts a custom starting directory instead of defaulting strictly to `$HOME`.

| Flag | Default | Behavior |
|------|---------|----------|
| `--entry <path>` or `-e` | `$HOME` | Sets the BFS root scan anchor. Can be relative, absolute (~expanded), or mounted volume path. |
| `--mode cli\|web` | `cli` | Switches output subsystem (see Sec 4). |

```bash
# Defaults to ~/
bun run index.ts --top 10

# Custom entry point (e.g., a large NAS share, another disk volume)
bun run index.ts -e /Volumes/Data/projects --depth 3
```

*Implementation note:* Path resolution resolves `~` and symlinks via `fs.realpathSync` before BFS initialization. If the entry path does not exist or is unreadable, the program exits with exit code `69` (EX_NOINPUT).

---

## 1. Scanning Model — Layer-by-Layer BFS

### Traversal Strategy

| Concept | Detail |
|---------|--------|
| **Root** | `$HOME` (auto-detected via `os.homedir()`) |
| **Direction** | Breadth-First Search (BFS) |
| **Layer 0** | `$HOME` itself |
| **Layer 1** | All direct children of `$HOME` that are directories |
| **Layer 2** | Children of each Layer-1 directory |
| **…continues** | Until `maxDepth` or symlink loop detected |

```
Layer 0: /Users/abhishekkumar/
              │
        ┌─────┼────────────┬──────────────┐
Layer 1: Desktop  Documents  Downloads    Library  ...
                              │
             ┌────────┬───────┴───────────┐
Layer 2:    work     personal     Caches   DerivedData  ...
```

### Enqueue Logic (per queue iteration = one layer)

```
for each queued path:
    readdir(path, { withFileTypes: true })
    filter → directories only (for enqueueing), files only (for metrics)
    skip symlinks (lstat check)
    deduplicate via visited Set
    push new dirs to next-queue
```

---

## 2. Data Model — Node Enrichment

Every filesystem entry produces a `FileSystemNode` with:

| Field | Type | FS API Source | Purpose |
|-------|------|---------------|---------|
| `path` | `string` | `dirent.name` resolved | Identity — used as unique key |
| `name` | `string` | `dirent.name` | Display name |
| `type` | `"file" \| "dir"` | `dirent.isFile() \| isDirectory()` | Classify for metrics routing |
| `sizeBytes` | `number` | `stat.size` | Raw space consumed |
| `mtimeMs` | `number` | `stat.mtime.getTime()` | Last-modified epoch (ms) |
| `birthtimeMs` | `number` | `stat.birthtime.getTime()` | Creation-time epoch (ms) |
| `cftimeMs?` | `number` | `stat.cchangeTime?` (rare) | Change/final metadata time |
| `depth` | `number` | Traversal counter | Layer position |
| `parentPath` | `string` | BFS queue parent | Parent reference |

### Aggregated Directory Node (`DirSummary`)

When a directory is fully scanned, it accumulates:

```typescript
interface DirSummary {
  path: string;
  depth: number;
  layer: number;

  // Raw totals
  totalSizeBytes: number;
  fileCount: number;
  subDirCount: number;
  maxDepthReached: number;

  // Timing snapshots
  earliestBirthtimeMs: number;   // oldest child birth time
  latestMtimeMs: number;         // youngest child mtime
  latestBirthtimeMs: number;     // newest child birth time
  avgFileAgeDays: number;        // weighted by size

  // Growth signals (populated by metrics engine)
  fillRateMBperDay: number;      // net speed of space consumption
  hungerScore: number;           // composite 0-100
  patterns: FileGrowthPattern[]; // detected behavioral pattern flags

  // Hierarchy
  layerKey: string;             // "Layer2~/Documents"
  siblingRank: number;          // rank among siblings at same parent
}
```

---

## 3. Fill-Rate Calculation — Core Algorithm

### 3a. Direct Mtime-Based Fill Rate

For each file inside a directory, compute time-since-last-modified. Files modified recently are "actively eating space."

```
for each file f in dir:
    ageDays   = (now - f.mtimeMs) / 86400000
    activeDays = max(ageDays, 1)                // avoid divide-by-zero
    rate      = f.sizeBytes / activeDays         // bytes-per-day attribution

dir.fillRateMBperDay += rate
```

**Intuition:** A 500 MB file modified yesterday → `rate = 500 MB/d`. Same file modified a year ago → `rate ≈ 1.4 MB/d`. The metric rewards recency.

### 3b. Birth-Time-Gated Fill Rate

Files that were *just created* contribute at full rate (they're brand new). Older files depreciate — they contributed all their weight on day zero.

```
newness = clamp((now - f.birthtimeMs) / creationWindow, 0, 1)   // e.g., window = 30 days
rate    = f.sizeBytes / (newness > 0 ? newness * totalDays : Infinity)
```

This catches **"burst creators"** — dirs that suddenly received massive files (cloned repos, downloaded archives).

### 3c. Combined Fill Rate

```
combiRate = mtimeRate × 0.6 + birthGatedRate × 0.4
```

Weighted because:
- 60% mtime → catches iterative growth (editors growing project files)
- 40% birth-gate → catches bulk events (git clone, download, copy-in)

---

## 4. Output Format — Dual Mode (Requirement 2 & 3)

### Mode A: CLI Mode (`--mode cli` — default)

Prints all metrics textually to stdout / stderr, sorted by hunger score.

```bash
bun run index.ts --top 10
```

Primary table layout:

```
🍽️ Hunger Meter — Storage Eaters (Layer-by-Layer from ~/)
   Scan depth: 3 | Entries visited: 12,847 | Duration: 2.4s


EATERS LEADERBOARD
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ════════  ═══════════
 Rank    Path                                           Size        Rate
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ════════  ═══════════
 🥇 #1   ~/Library/Developer/Xcode/DerivedData          24.3 GB     +1.2 GB/d
 🥈 #2   ~/Library/Caches/com.google.Chrome             18.7 GB     +850 MB/d
 🥉 #3   ~/Library/MobileDocuments…/Notes               12.1 GB      +34 MB/d
  #4     ~/Movies/iMovie Library                         8.4 GB        0 B/d*
  #5     ~/Developer/monorepo/node_modules              6.2 GB     +12 MB/d
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ════════  ═══════════
 * = inactive (>30 days since last write)


 LAYER SIBLING BREAKDOWN
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Layer #1 — ~/Library (~245 GB total)
   🥇 Developer       → 87.3 GB (36%)  +1.4 GB/d  ← hungeriest
   🥈 Caches          → 62.1 GB (25%)  +920 MB/d
   🥉 Preference      → 18.4 GB (7%)        ~0 B/d
```

### Mode B: Web UI Mode (`--mode web`)

Starts a local Bun HTTP/HTTPS server and serves a single-page dashboard in the browser.

| Sub-command | Behavior |
|-------------|----------|
| `bun run index.ts --mode web` | Starts server on `http://localhost:3000`, scans entry-point once, streams results via WebSocket / SSE for live updates. |
| `bun run index.ts --mode web --port 8085` | Custom port binding. |

#### Web Dashboard Layout

The UI consists of three panels with interactive charts bound to raw metric data:

**Panel A — Global Summary (Top Bar)**
- Total bytes scanned, total unique files, scan duration.
- Top-level "System Hunger Index" (composite 0–100 weighted average).

**Panel B — Layer Tree Explorer (Left sidebar / collapsible)**
- Collapsible hierarchy from entry-point down to `--depth`.
- Each node shows size + fill rate inline; clicking a node fetches sibling breakdown for that parent.

**Panel C — Analytics View (Main content area, swaps by selection)**
Upon selecting a directory or top-eater row, Panel C renders:

| Metric Set | Primary Chart Type | What it shows |
|-----------|-------------------|---------------|
| **Hunger Score + Fill Rates** (M1–M3) | Horizontal bar chart (ranked bars for all siblings at that layer) | Immediate relative hunger comparison |
| **Dir-vs-Child Age Delta** (M4) + C2S (M5) | Dual-axis bar/scatter plot | X = age delta in days, Y = C2S ratio. Quadrants highlight urgency (top-right = old dir, new files = late populator). |
| **Cohort Trend** (M7) + Birth Entropy (M6) | Line chart with confidence band over months | Future space consumption projection; trend slope annotated in top-left corner. |
| **Sibling Imbalance / Depth Conc.** (M8–M9) | Pie chart (imbalances at layer level) + Sunburst chart (deep iceberg visualization) | Visual fraction of "hidden" bytes vs visible bytes. Shows which layers burry the biggest files. |
| **Inode Risk / Extension Profile** (M10–M13) | Stacked donut chart (file extensions by bytes) + Inode gauge meter | Dominant file-type heatmap with numeric inode depletion warnings if small-file density >60%. |

#### Web UI Input Field (Requirement 3)

The dashboard top-bar includes a text input for the entry point:
```html
<input id="entryPoint" type="text" placeholder="/path/to/scan" value="$HOME">
<button onclick="reScan()">▶ Scan</button>
```
On submit, the frontend POSTs the new path to `/api/restart`; the backend re-initializes BFS with the fresh entry point without page reload.

### Input Handling Summary (Requirement 3)

| Mode | How user provides entry-point & config |
|------|----------------------------------------|
| **CLI** | `--entry /path --depth 4 --top 20` arguments passed to Bun process. |
| **Web UI** | Text inputs inside the dashboard page bound to a `/api/scan` POST or `/api/restart`. |

Both modes share identical backend scanning logic (BFS walker + Metrics Engine), so the results are byte-for-byte identical regardless of input channel.

---

## 5. Safety Guarantees — Zero-Write Policy

| Guarantee | How Enforced |
|-----------|-------------|
| **Read-only** | Only `fs.statSync`, `readdirSync` with `{ withFileTypes: true }` — no write APIs called anywhere |
| **No symlink loops** | `lstatSync` on every entry; entries where `isSymbolicLink()` is true → skipped; visited Set across all layers |
| **No deletion possible** | Zero usage of `fs.unlink`, `fs.rm`, `fs.rename`, `fs.truncate`. Verified by grep at build time via CI lint rule |
| **Permission errors** | Swallowed silently with debug-level logging (use `--verbose` flag to see them) |
| **Deep-path OOM** | Capped entry count at 10 million; early-exit with warning if reached |

### Dependency Pledge

**Zero external dependencies.** Pure Bun native APIs: `fs`, `os`, `path`, `util`. No npm packages.

---

## 6. Implementation File Layout

```
hunger-meter/
├── index.ts          # CLI entry, argument parsing, result formatting
├── scanner.ts        # BFS layer-by-layer walker, symlink guard, dedup
├── metrics.ts        # All hunger-factor calculations (fill rate, patterns)
├── types.ts          # FileSystemNode, DirSummary, MetricsConfig interfaces
├── docs/
│   ├── PLAN.md       # ← this file
│   ├── METRICS.md    # Extended & advanced metrics reference
│   └── ARCHITECTURE.md  # Code flow, data flow diagrams
```

---

## 7. Development Milestones

| Phase | Scope | Output |
|-------|-------|--------|
| **M1** | Core scanner + Mtime fill rate (M1) + CLI table output | `bun run index.ts --top 10` works, custom `-e /path` accepted |
| **M2** | Birth-gate rate (M2) + sibling breakdown per layer + Web UI skeleton (Bun HTTP server + HTML with static data binding) | `--mode web` starts `http://localhost:3000` showing raw JSON; CLI still works |
| **M3** | Advanced metrics (M4–M6 entropy, age distribution, burst detection) + Interactive Web UI charts (Chart.js / D3 via CDN) + dual-mode parity | `--mode web` shows live graph panels; `--patterns` flag enabled for CLI |
| **M4** | Continuous watch mode (M12 temporal clustering) + trend snapshot diffing + WebSocket live-push to Web UI | `bun run index.ts --watch 60` updates browser in real-time |
| **M5** | Alert thresholds + JSON report export + Web UI threshold slider control | `bun run index.ts --alert 5GB/d --format json` and dashboard alert toggles |

---

*Next step: review METRICS.md for extended measurement dimensions → then begin scaffolding code.*

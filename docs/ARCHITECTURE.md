# Code Architecture — Data Flow & Component Contracts

## System Context Diagram

```
┌───────────────────────── Input Channel ─────────────────────────┐
│  CLI args (--entry /path --depth N --mode cli|web --port X)     │
│         OR                                                       │
│  Web UI text input field ───── POST /api/restart ────────────────┘
└──────────────────────────────┬───────────────────────────────────┘
                               │ unified Config object
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                    index.ts (Bun, Orchestrator)              │
│  parseArgs() → validate entryPath (resolve ~, realpathSync)  │
│  dispatchMode(config.mode)                                   │
└───┬──────────────────────────────┬──────────────────────────┘
    │ CLI mode                     │ Web UI mode
    ▼                              ▼
┌──────────────┐         ┌──────────────────────────────────────┐
│ bun:cli      │         │ Bun HTTP Server (port 3000 / user)   │
│ ·printTable()│         │ GET /          → SPA HTML dashboard  │
│ ·color output│         │ GET /api/data  → initial scan JSON   │
│              │         │ POST /api/restart → new BFS run      │
└──────┬───────┘         │ SSE/WebSocket push → live updates    │
       │                  └───────────┬───────────────┬────────┘
       │                              │               │ (same core)
       ▼                              ▼               ▼
┌───────────────────────────────────────────────────────────────────┐
│                     Pure Processing Pipeline                      │
│                   ←── shared by CLI & Web UI ───→                │
└───┬──────────────────────┬───────────────────────────┐        │
    │                      │                           │        │
    ▼                      ▼                           ▼        │
 lstat guard          visited Set                 metrics.ts  │
 (symlink-skip)      (dedup by path)              ·M1..M14   │
                    recursive                       pure funcs│
                    queue push                                   │
└───────────────────────────────────────────────────────────────┘
           │ DirSummary[] ranked + grouped by layer
           ▼
┌─────────────────────────────────────────────────────────────┐
│                    Formatter / JSON Serializer               │
│  renderCLI(tableData: TableRows)          → stdout            │
│  toJSON(DashboardData)              → JSON payload to web    │
└─────────────────────────────────────────────────────────────┘
```

*Note:* The core scanning and metrics pipeline is **100% pure** — it produces objects, never writes to console or network. The only mode-specific layer sits at the very top (input parsing) and very bottom (output transport). This means `bun run index.ts` and the HTTP server call identical logic paths.

---

## Component Contracts

### 1. `types.ts` — Shared Interfaces

```typescript
// Core filesystem node (one entry from readdir + statSync)
export interface FileSystemNode {
  path: string;
  name: string;
  type: 'file' | 'dir';
  sizeBytes: number;
  mtimeMs: number;      // last-modified epoch ms
  birthtimeMs: number;  // creation epoch ms
  depth: number;        // absolute depth from root
  layer: number;        // BFS layer (0=root, 1=siblings, 2=grandchildren...)
}

// Aggregated directory summary (post-analysis)
export interface DirSummary {
  path: string;
  name: string;
  depth: number;
  layer: number;

  // Raw totals
  totalSizeBytes: number;
  fileCount: number;
  subDirCount: number;
  maxDepthReached: number;

  // Timing
  earliestBirthtimeMs: number;
  latestMtimeMs: number;
  latestBirthtimeMs: number;
  avgFileAgeDays: number;

  // Computed metrics (populated by MetricsEngine)
  mtimeFillRateMBperDay: number;
  birthGateFillRateMBperDay: number;
  compositeFillRateMBperDay: number;
  ageDeltaDays?: number;       // M4 — dir vs child age delta
  c2sRatio?: number;           // M5 — creation-to-size ratio
  birthEntropy?: number;        // M6 — stdDev of file birthtimes
  cohortTrendSlope?: number;    // M7 — monthly trend slope (MB/month)
  cohortR²?: number;            // M7 — linear regression R-squared
  depthConcentration?: number;  // M8 — how much is hidden deep
  hungerScore: number;          // composite 0-100
  patterns: FileGrowthPattern[];

  // Hierarchy context
  parentPath: string;
  layerKey: string;             // e.g. "Layer2~/Documents"
  siblingRank: number;          // rank among siblings of same parent
}

export interface FileGrowthPattern {
  type: 'burst_creator' | 'late_populator' | 'iceberg' | 'erratic' | 'linear_growth' | 'exponential_growth' | 'stable_plateau';
  confidence: number;           // 0–1 probability
  description: string;
}

// Scanner configuration
export interface ScannerConfig {
  root: string;                 // e.g. ~/ or custom path
  maxDepth: number;             // max BFS depth (default: 5)
  symlinkPolicy: 'skip' | 'follow';  // default: 'skip'
  entryCountLimit: number;      // abort and warn (default: 10_000_000)
}

// Metrics configuration
export interface MetricsConfig {
  weights?: Partial<{                     // composite score weight overrides
    mtimeFillRate:          number;   // default: 0.25
    compositeFillRate:      number;   // default: 0.30
    trendSlope:             number;   // default: 0.25
    siblingImbalance:       number;   // default: 0.05
    icebergPenalty:         number;   // default: 0.10
    inodeSafetyMargin:      number;   // default: 0.05
  }>;
  cohortGranularity: 'day' | 'week' | 'month' | 'quarter';  // default: 'month'
  creationWindowDays: number;         // M2: how recent to count as "new" (default: 30)
}

// CLI table row
export interface TableRow {
  rank: number;
  emoji: string;           // 🥇🥈🥉#N
  path: string;
  size: string;            // formatted: "24.3 GB"
  fillRate: string;        // formatted: "+1.2 GB/d"
  hungerScore: number;     // for color encoding
}

export interface LayerBreakdown {
  layerKey: string;
  parentPath: string;
  totalSizeBytes: number;
  siblingCount: number;
  siblings: Array<{
    name: string;
    sizeStr: string;
    percentOfParent: number;
    fillRate: string;
    hungerScore: number;
    rank: number;
  }>;
}
```

---

### 2. `scanner.ts` — BFS Layer Walker

**Responsibilities:**
1. Initialize queue with root path + depth=0, layer=0
2. Pop front → lstat → stat (two-pass for size)
3. Separate files vs subdirectories
4. Skip symlinks via `lstat.isSymbolicLink()`
5. Dedup via `visited.path` Set (across ALL layers)
6. Yield per-layer: `{ layer, path, nodes }`  →  `yield*` as generator for memory efficiency

```typescript
/**
 * Scan root directory layer-by-layer using BFS.
 * Never writes, never follows symlinks, deduplicates across all layers.
 * Returns a generator that yields one layer at a time.
 */
export function* bfsWalk(config: ScannerConfig): Generator<LayerResult> {
  const visited = new Set<string>();
  let currentQueue = [config.root];
  let layer = 0;

  while (currentQueue.length > 0 && layer <= config.maxDepth) {
    const nextQueue: string[] = [];
    const layerNodes: FileSystemNode[] = [];

    for (const path of currentQueue) {
      if (layer === 0) {
        // Root node — stat it directly
        const rootStat = sync.statSync(path);
        yield buildDirSummary(path, config.root, layer, { sizeBytes: rootStat.size, ... });
        continue;
      }

      const entries = sync.readdirSync(path, { withFileTypes: true });

      for (const dirent of entries) {
        const fullPath = join(path, dirent.name);

        // Symlink guard - always skip
        if (dirent.isSymbolicLink()) continue;

        // Dedup guard
        if (visited.has(fullPath)) continue;
        visited.add(fullPath);

        const entryStat = sync.statSync(fullPath);

        const node: FileSystemNode = {
          path: fullPath,
          name: dirent.name,
          type: dirent.isFile() ? 'file' : 'dir',
          sizeBytes: entryStat.size,
          mtimeMs: entryStat.mtimeMs,
          birthtimeMs: entryStat.birthtimeMs,
          depth: layer + (dirent.isDirectory() ? 1 : 0),
          layer,
        };

        if (dirent.isDirectory()) {
          nextQueue.push(fullPath);
        }

        layerNodes.push(node);
      }
    }

    yield { layer, path: config.root, nodes: layerNodes };
    currentQueue = nextQueue;
}
```

---

### 3. `metrics.ts` — Scoring Engine

**Responsibilities:**
1. Accept `FileSystemNode[]` grouped by parent directory
2. Compute all DirSummary fields (timing, aggregation)
3. Run metrics pipeline: M1 → M2 → M4–M6 → M7 → M8 → M9 → M10 → M14
4. Normalize fill rates across siblings in the same layer/parent
5. Combine weighted composite into `hungerScore` (0–100)
6. Attach detected patterns to `patterns` array

```typescript
export function computeMetrics(
  nodesByParent: Map<string, FileSystemNode[]>,
  config: MetricsConfig
): DirSummary[] {
  const results: DirSummary[] = [];

  for (const [parentPath, nodes] of nodesByParent) {
    const dirs = nodes.filter(n => n.type === 'dir');
    const files = nodes.filter(n => n.type === 'file');

    if (dirs.length === 0 && files.length === 0) continue;

    // Build raw summary from file stats aggregated per parent
    const summary = buildRawSummary(parentPath, dirs, files);

    // Compute individual metrics in pipeline order
    summary.mtimeFillRateMBperDay = computeMtimeFillRate(files, config);
    summary.birthGateFillRateMBperDay = computeBirthGateRate(files, config);
    summary.compositeFillRateMBperDay =
      summary.mtimeFillRate * 0.6 + summary.birthGateRate * 0.4;

    // M4: Dir vs file age delta
    const parentStat = sync.statSync(parentPath);
    if (files.length > 0) {
      const childAvgBirth = files.reduce((sum, f) => sum + f.birthtimeMs, 0) / files.length;
      summary.ageDeltaDays = (parentStat.mtimeMs - childAvgBirth) / 86400000;  // approximated from mtime since birthtime unreliable for dirs on some FS
    }

    // M5: C2S ratio
    const daysAlive = max(now - parentStat.mtimeMs, 86400000) / 86400000;
    summary.c2sRatio = summary.totalSizeBytes / (daysAlive * 1_000_000);     // MB/day

    // M6: Birth entropy
    summary.birthEntropy = stdDev(files.map(f => f.birthtimeMs));

    // M7: Cohort trend analysis
    const cohortData = buildCohortBuckets(files, config);
    summary.cohortTrendSlope = linearRegressionSlope(cohortData.sizes, cohortData.timeLabels);
    summary.cohertR² = rSquaredOfRegression(cohortData.sizes, summary.cohortTrendSlope, cohortData.sizes.length);

    // M8: Depth concentration (requires traversal into subdirs)
    summary.depthConcentration = computeDepthConcentration(dirs, files);

    results.push(summary);
  }

  // Post-processing: sort by hungerScore → assign ranks within each parent
  // Normalize fill rates across siblings for score scaling
  return rankAndNormalize(results);
}
```

---

### 4. `index.ts` — Mode Dispatcher, CLI Formatter & Web Server

**Responsibilities (depends on mode):**

| Mode | Responsibilities |
|------|-----------------|
| **CLI mode** (`--mode cli`) | Parse args → resolve entry path → dispatch scan → format to stdout table |
| **Web UI mode** (`--mode web`) | Same parsing, then spin up Bun HTTP server + SPA HTML + API endpoints for data & live refresh |

```typescript
const config = parseArgs(Deno.args);        // custom argv parser (Bun built-in)

// 1. Validate & resolve entry path
const rootDir = config.entry ?? os.homedir();
const resolvedRoot = realpathSync(rootDir);   // throws EX_NOINPUT if unreachable
if (!resolvedRoot) process.exit(69);

console.log('🍽️ Hunger Meter — Scanning from %s...\n', resolvedRoot);

// 2. Run shared scanning pipeline (identical for both modes)
const allLayers = [];
for (const result of bfsWalk({ root: resolvedRoot, maxDepth: config.depth })) {
  allLayers.push(result);

  if (result.nodes.length > 0) {
    const parentGrouped = groupByParent(result);
    for (const [_key, nodes] of Object.entries(parentGrouped)) {
      runMetrics(nodes, metricsConfig);   // populates DirSummary per parent
    }
  }
}

// 3. Dispatch to mode-specific output
if (config.mode === 'cli') {
  renderCLI(allLayers);                    // stdout table + colored bars
} else if (config.mode === 'web') {
  startServer(resolvedRoot, allLayers);     // Bun serve() below
}
```

### 5. `server.ts` — Web UI HTTP Server (Bun-native)

**Responsibilities:**
- Serve SPA HTML/CSS/JS from an inline `serveStatic()` or file directory
- Provide REST API `/api/data` returning full `DashboardData` JSON
- Provide SSE / WebSocket endpoint for live stream when `--watch N` is active
- Accept POST to `/api/restart` with new entry path from Web UI text field, re-run BFS, flush output

```typescript
import { serve } from 'bun';
import { bfsWalk } from './scanner';
import { computeMetrics } from './metrics';
import type { DashboardData, ScanRequest } from './types';

export function startServer(resolvedRoot: string, initialResults: LayerResult[]) {
  const server = serve({
    port: 3000,
    async fetch(req) {
      const url = new URL(req.url);

      // Serve SPA dashboard HTML/CSS/JS
      if (url.pathname === '/' || req.method === 'GET') {
        return new Response(HTML_SPASHRPA_AS_STRING, { status: 200, headers: { 'Content-Type': 'text/html' } });
      }

      // POST /api/restart — accept custom entry point from UI text input
      if (req.method === 'POST' && url.pathname === '/api/restart') {
        const body = await req.json() as ScanRequest;
        const newRoot = realpathSync(body.entryPath ?? os.homedir()) ?? '';
        if (!newRoot) return new Response(JSON.stringify({ error: 'invalid entry path' }), { status: 400 });

        // Re-run full pipeline with new root
        const freshLayers: LayerResult[] = [];
        for (const result of bfsWalk({ root: newRoot, maxDepth: body.maxDepth ?? 5 })) {
          freshLayers.push(result);
          if (result.nodes.length > 0) {
            const grouped = groupByParent(result);
            runMetricsForAll(grouped, metricsConfig);
          }
        }
        return jsonResponse(buildDashboardData(freshLayers));  // 200 OK with full scan data
      }

      // GET /api/data — return initial results from startup args
      if (url.pathname === '/api/data') {
        return jsonResponse(buildDashboardData(initialResults));   // 200 OK
      }

      return new Response('Not Found', { status: 404 });
    },
  });

  console.log(`🌐 Web UI ready at http://localhost:${server.port}`);
}
```

---

## Error Handling Strategy

| Scenario | Handling |
|----------|----------|
| `permission denied` on statSync | `try/catch` → log to stderr (verbose), skip entry, continue |
| Symlink detected | Skip entirely (pre-write guard already prevents follow) |
| Visited set already contains path | Skip — dedup prevents infinite BFS loops from bind mounts |
| Entry count > limit | Early exit, print warning with stats so far |
| `birthtimeMs === 0` (unsupported FS) | Use mtime as proxy; add marker `"birthtimeUnavailable: true"` to DirSummary |
| Extremely large single file (>1 TB) | Log to stderr, include in totals but flag `"unusuallyLarge: true"` pattern |

## Performance Notes

- **Generator-based BFS**: memory scales with one layer at a time, not entire tree. Only layer summaries persist.
- **Batch statSync calls**: Bun supports batching in future; currently `statSync` per entry is the constraint. Expect ~50–200 entries/sec depending on filesystem type (NVMe vs HDD vs network).
- **No JSON serialization until output phase**: raw DirSummary objects stay typed in memory.

---

## Future: Watch Mode Extension Point

```typescript
// Not implemented in v1 — scaffolded interface for Phase 4
interface WatchConfig {
  intervalMs: number;           // default: 60_000 (1 min)
  diffMode: 'delta' | 'snapshot';
  alertThresholdMB: number;     // flag dirs that grew > X MB between ticks
}

function* watchCycle(config: WatchConfig): AsyncGenerator<WatchTick> {
  while (true) {
    const prev = await snapshot(config);
    await sleep(config.intervalMs);
    const current = await snapshot(config);
    yield diff(prev, current);   // only yields dirs that changed meaningfully
  }
}
```

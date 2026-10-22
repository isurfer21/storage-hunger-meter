# Hunger Factor — Extended Metrics Reference

This document catalogs every measurable dimension from which "storage hunger" can be derived. Each metric is designed to detect a different behavioral pattern of disk consumption.

---

## A. EXISTING METRICS (from PLAN.md)

### M1 — Mtime-Based Fill Rate (Active Write Speed)
```
fillRate = Σ(file.size / max(ageDays, 1))    for files within last N days
```
**Detects:** Iterative growth — editors updating project files, logs growing continuously, databases appending.

### M2 — Birth-Gate Fill Rate (Burst Creator Signal)
```
newness = clamp((now - birthtime) / window, 0, 1)    // window = default 30 days
fillRate = Σ(file.size × newness / totalDaysSinceProjectStart)
```
**Detects:** Sudden ingestion — git clone, large download, copy-in. Files that are "born young" and already fat.

### M3 — Composite Hunger Score (weighted blend of M1+M2)
```
score = normalize(mtimeRate × 0.6 + birthRate × 0.4, acrossSiblings)    // 0 to 100 per layer
```

---

## B. CREATION-TIME ANALYSIS METRICS (new — user-specified domain)

These metrics correlate the **directory's own age** with its children's age profile.

### M4 — Directory vs Files Age Delta (Δage = DirBirth − ChildAvgBirth)

```
dirAge    = now - parentDir.birthtimeMs     // how long this dir itself has existed
childAge  = Σ(child.birthtimeMs) / fileCount // average birth time of children

deltaDays = dirAge - childAge                 // DIR is OLDER than its children
                                    or CHILDREN are YOUNGER (newly populated)
```

**Signals:**
| Δage value | Interpretation | Hunger implication |
|-----------|----------------|--------------------|
| `> 365 days` | Directory existed, files arrived recently | **Sudden populate event** — potential burst eater |
| `0 – 30 days` | Dir and children born together | Organic growth from creation — moderate hunger likely |
| `< -90 days` | Children are OLDER than directory | Renamed/moved directory — metrics unreliable; deprioritize |
| `≈ 0` (±1 day) | Born simultaneously | Fresh folder with early content — still seeding phase |

**Threshold rule:** If `deltaDays > threshold` (e.g. 90 days), flag as `"late_populator"` pattern → elevated hunger weight because the dir was dormant then suddenly active.

---

### M5 — Creation-to-Size Ratio (C2S)

```
c2sRatio = totalDirSizeBytes / max(daysSinceDirBirth, 1)
         // bytes per calendar day of directory life
```

**Signals:**
| c2s ratio | Behavior |
|-----------|----------|
| `> 5 GB/day` | Extreme burst — archive dump, full backup restore, VM image creation |
| `100 MB–5 GB/day` | Normal project/workspace growth |
| `< 10 MB/day` | Ambient/background consumption (cache, temp, log) |
| `~∞` (dir birth = now, children have size) | Instant fill — likely compressed archive or copied dataset |

**Use case:** High C2S on a *new* directory is NOT dangerous (it's just full at birth). High C2S on an *old* directory IS dangerous (the dir has suddenly started eating). Combine with M4: C2S only matters when `deltaDays > 0` (dir older than children).

---

### M6 — Birth Time Entropy (File Age Dispersion)

For files inside a directory, measure how spread out their birth times are.

```
birthEntropy = stdDev(birthtimeMs of all child files) / normalized against file count
           = 0   → all files created at the same instant (one event)
           = high → files created over weeks/months (sustained ingestion)
```

**Signals:**
| Entropy | Pattern type | Hunger behavior |
|--------|-------------|-----------------|
| `≈ 0` | Single-burst birth | All-at-once eater; already at peak, rate will drop |
| `low–mid` | Gradual accumulation | Healthy organic growth; sustained fill rate |
| `high` | Sporadic large inserts | **Erratic** — one big file every few weeks. Unpredictable hunger curves |

**Combination rule:** Low-entropy + high total-size = already full but was a burst (lower future risk). High-entropy + rising current mtime = continuing unpredictable eater (higher monitoring priority).

---

### M7 — Cohort-Based Trend Analysis (Cross-Dir Birth Grouping)

Group all files inside a directory into "cohorts" by birth time, then measure cohort size growth over time.

```
cohorts := bucket files by month of birthtime
cohortSizes = [bytes_in_month_1, bytes_in_month_2, …, bytes_in_last]

trendSlope  = linear regression slope of cohortSizes over time
trendR²     = how well the line fits (0 = random, 1 = consistent)
```

**Signals:**
| trend + direction | Pattern | Actionable insight |
|------------------|---------|--------------------|
| `positive slope + high R²` | **Linear growth cohort** — eating steadily each month | Predict when it will be full: `remainingCapacity / slopePerMonth` |
| `exponential fit > linear` | **Exponential growth** (dev team growing fast, logs expanding double-weekly) | Highest priority — exponential curves eat space fastest near the end |
| `flat trend + high R²` | Stable plateau — full and stable | No action needed; it's at equilibrium |
| `jagged / low R²` | Erratic — irregular bulk inserts | Cannot predict reliably; monitor for sudden spikes only |
| `negative slope` | Shrinking — cleanup happened (or data was removed) | De-prioritize |

---

### M8 — Dir-Depth vs Size Concentration (Deep-Eater Signal)

```
depthConcentration = Σ(file.size × 1/shownPathDepth) / totalDirSize
                    // files deeper in hierarchy contribute less to "visible" hunger but more to index cost
```

A dir that looks small on the surface but has massive files buried 8+ levels deep is an **"iceberg"** — it appears hungry-free until its parent dir fills.

**Signals:**
| concentration value | Pattern |
|--------------------|---------|
| High (>0.7) | Shallow files dominate (visible at parent level) |
| Low (<0.2) | **Iceberg directory** — looks empty, actually huge underneath → high hidden hunger |

---

### M9 — Sibling Imbalance Ratio (Outlier Detection)

For each layer (siblings under same parent):

```
imbalance = maxSiblingSize / Σ(allSiblingsSizes)   // what fraction of the pie is biggest?

// Also: Gini coefficient across all siblings in the layer
```

**Signals:**
| ratio | Meaning |
|------|---------|
| `> 0.7` | One dir eats >70% of parent — clear outlier, primary target |
| `0.4–0.7` | Two or three dominant dirs worth watching |
| `< 0.3` | Evenly distributed hunger across many siblings — systemic rather than localized |

**Use case:** If sibling A has 60% and B has 2%, you only need to track A's trend, not waste cycle on B.

---

## C. ADDITIONAL BEHAVIORAL METRICS

### M10 — File Count–to–Size Divergence

```
avgFileSize   = totalSize / fileCount
ratioToMedian = avgFileSize / median(fileSizes)
```

**Signals:**
| ratio | Meaning |
|------|---------|
| `> 3` (mostly outliers) | Few massive files → space-eating, not inode-eating |
| `< 0.1` (many small) | Many tiny files → **inode hunger** — fills up inodes even when disk space remains |
| `≈ 1` | Uniform distribution — normal project structure |

### M11 — Inode Hunger Index

```
inodeRisk = Σ(1 / uniqueFileSizeBucket)   // bucket by size, smaller buckets count more
           normalized across parent layer
```

Directories with thousands of sub-1 KB files (`.DS_Store`, caches, temp files) are **space-invisible but inode-threatening**. A macOS `/` drive can run out of inodes before running out of bytes.

### M12 — Temporal Activity Clustering

Group file writes by day (using `mtime`). Detect time-of-day and day-of-week patterns.

```
hourlyMap = {0..23}: countWritesPerHour
dailyMap  = {Mon..Sun}: counts

activityScore = Σ(hourlyMap[peakHours] * weights) / totalWrites
```

**Signals:**
| pattern | Meaning |
|--------|---------|
| Peak at 2–5 AM nightly | Automated backup, cron job, CI artifact generation |
| Peaks on weekdays 9–6, zero weekends | Human developer activity |
| Random distribution | Cache/buffer growth (no human rhythm) |

**Action:** If periodic peak is detected, predict space needs for the next cycle. E.g., "Every night at 3 AM this dir gains ~2 GB → prepare alert at day-of-week N before the event."

### M13 — Extension-Dominance Profile

```
extDistribution = group files by extension, sum sizes per ext
dominantExt     = top-3 extensions by total bytes
topExtShare     = dominantExtTotal / dirTotalSize
```

**Signals:**
| dominant | Typical behavior |
|----------|-----------------|
| `.log`, `.jsonl`, `.csv` | Log/appender growth — predictable linear fill |
| `.db`, `.sqlite` | Database growing with inserts — predict from write-frequency |
| `.git`, `.xcodeproj` | Development workspace — burst when new branch/clone, then dormant |
| `.mp4`, `.mov`, `.wav` | Media project files — human creative work; periodic bursts |
| `.pkd` / no ext | Binary blob (model weights, dataset) — likely static or infrequent updates |
| Many unique/no-ext | Cache/temp directory — unpredictable pattern, needs M12 + active monitoring |

### M14 — Age Pyramid Distribution

Classify files by age into buckets and measure the pyramid shape:

```
pyramid := {
  "0-7d":   totalSizeOfFilesBornWithin7d,
  "8-30d":  totalSizeOfFilesBorn8to30dAgo,
  "31-90d": ...,
  "91-365d": ...,
  "365+d":  ...
}

topHeavy = pyramid["0-7d"] / dirTotalSize      // top-heavy = new files dominate
bottomHeavy = pyramid["365+d"] / dirTotalSize    // bottom-heavy = old cache pile-up
```

**Signals:**
| shape | Interpretation |
|------|----------------|
| Top-heavy | Newly active — still building toward peak capacity |
| Bottom-heavy (≥70% in 1y+) | Cache/data stagnation candidate → may benefit from cleanup review |
| Even pyramid | Healthy, balanced lifecycle |
| Middle-heavy (1-6 month bucket dominates) | Recently abandoned project — grew then stopped at a plateau |

---

## D. COMPOSITE HUNGER SCORE FORMULA

Combining all metrics into a practical 0–100 output:

```
hungerScore =  w1 × mtimeFillRateNorm     (weights current active ingestion)
            + w2 × compositeFillRateNorm   (catches burst creators)
            + w3 × trendSlopeNorm          (M7 — future trajectory prediction)
            + w4 × siblingImbalanceNorm    (M9 — only significant if it's an outlier)
            + w5 × icebergPenalty          (M8 — hidden depth hunger)
            + w6 × lowInodeSafetyMargin    (M10|M11 — inodes are a hidden kill-chain)
```

### Recommended weights (tunable via config):

| weight | component | reason |
|--------|-----------|--------|
| `w1 = 0.25` | mtime fill rate | Most direct signal: if it's eating NOW, it matters NOW |
| `w2 = 0.30` | composite fill rate (includes M4–M6 birth-time) | Burst pattern is the most common cause of sudden-space-loss |
| `w3 = 0.25` | trend slope | Looking forward, not just backward |
| `w4 = 0.05` | sibling imbalance | Contextual, only relevant per-layer |
| `w5 = 0.10` | iceberg penalty | If hidden depth is high, under-reporting risk is real |
| `w6 = 0.05` | inode safety margin | Hidden but dangerous |

**Threshold tiers:**
| score range | color | action |
|------------|-------|--------|
| 0–25 | 🟢 safe | no alert |
| 26–50 | 🟡 watch | surface in top-10 if enough data depth (≥3 cohorts) |
| 51–75 | 🟠 monitor | warn user, show predicted days-until-full |
| 76–100 | 🔴 critical | highlight as primary candidate for investigation/cleanup |

---

## E. METRIC MATRIX SUMMARY

All metrics at a glance:

| # | Name | Type | Computes | Detects | Required FS fields |
| | | Metric | Type | Computes | Detects | Required FS fields |
|---|------|------|--------|----------|---------|-------------------|
| M1 | Mtime Fill Rate | Speed | bytes/day from mtime | Active writes, log growth | `mtime`, `size` |
| M2 | Birth-Gate Rate | Speed | burst-aware fill using ctime | Sudden bulk ingestion | `birthtime`, `size` |
| M3 | Composite Score | Speed | M1×0.6 + M2×0.4 | Blended signal | — |
| M4 | Dir-vs-File Age Delta | Timing delta | dirBirth − childAvgBirth | Late population events | `dir.birthtime`, `file.birthtime` |
| M5 | Creation-to-Size Ratio | Rate | totalSize / daysSinceDirBirth | Burst density per calendar day | `totalSize`, `dir.birthtime` |
| M6 | Birth Time Entropy | Dispersion | stdDev(file.birthtimes) | Single-burst vs sustained | `file.birthtime` |
| M7 | Cohort Trend (MLR) | Regression | slope of monthly size cohorts | Linear/exponential future prediction | `file.birthtime`, `totalSize` |
| M8 | Depth Concentration | Distribution | depth-weighted size ratio | Iceberg directories | `relativePathDepth`, `size` |
| M9 | Sibling Imbalance | Statistical | maxSibling / ΣallSiblings | Outlier detection at layer level | `sibling sizes` |
| M10 | Count–to–Size Divergence | Distribution | avg / median file size | Space-eater vs inode-eater | `size`, `fileCount` |
| M11 | Inode Hunger Index | Risk | reciprocal of unique size buckets | I-node depletion risk | `fileCount`, `sizeDist` |
| M12 | Temporal Activity Clustering | Rhythm | hourly/daily write map | Automated vs human pattern | `mtime` |
| M13 | Extension Dominance | Profile | ext-bytes heatmap | File-type behavior mapping | `extension` |
| M14 | Age Pyramid | Distribution | age-bucket size profile | Lifecycle stage identification | `birthtime`, `size` |

---

## F. Web UI Dashboard — Chart-to-Metric Mapping (Requirements 2 & 3)

When running in `--mode web`, each metric family is rendered into specific interactive chart components for the dashboard. This section defines the exact visual contract so the frontend and backend share a common data schema.

| Metric(s) | Recommended Chart Type | Web UI Data Payload Shape | User Interaction |
|-----------|-----------------------|--------------------------|------------------|
| **M1 + M3** (Mtime Fill Rate, Composite Score) | Ranked horizontal bar chart (one row per sibling at selected layer). Color-coded by hunger score tier (green <25, green-yellow 25-50, orange 51-75, red >75). | `{ siblings: [{name, path, size, fillRateMBd, hungerScore, color}] }` | Hover → tooltip with full metrics; click sibling → refresh Panel C for that dir. |
| **M4 + M5** (Age Delta, C2S Ratio) | Scatter plot (X-axis = deltaDays, Y-axis = C2S_MBD). Quadrants drawn at origin (0,0) to visually categorize dirs: Top-Right = "late_populator", Bottom-Left = "stable". | `{ points: [{name, x:deltaDays, y:c2sRatio, quadrant:'...' }] }` | Drag box selector on plot → highlights matching sibling bars in Panel A. |
| **M7** (Cohort Trend) + **M6** (Birth Entropy) | Smoothed line chart over months with shaded confidence interval (R² determines opacity). | `{ series: [{label, values:[{month, bytes}], slope, r2, entropy}] }` | Click data point → drill down to cohort file list (file names that contributed to that month's bytes). |
| **M8** (Depth Conc.) + **M9** (Sibling Imbalance) | Sunburst chart (concentric rings per layer depth; ring width = size %) combined with a Donut chart for top-level sibling shares. | `{ sunburst: [{id, parent, value, label}], donut: [{label, value}] }` | Click ring segment → highlights corresponding siblings in Bar Chart. |
| **M10** + **M11** (Count–to–Size Divergence, Inode Risk) | Dual-panel gauge/meter: Left = avg file size distribution histogram; Right = inode depletion "fuel gauge" reading 0% to 100%. | `{ histBins: [{range, count}], inodePercent: number, inodeCritical: boolean }` | On hovering bars → shows exact file count and size-range text. |
| **M13** + **M14** (Extension Dominance, Age Pyramid) | Stacked donut chart (by extension color-code) with an age-pyramid heatmap beneath it (rows=age buckets, cols=extension types, cell fill = bytes). | `{ extStack: [{ext, totalBytes, pct}], agePyramid: {'0-7d':{extA:bytes...}, '8-30d':{...} } }` | Filter by clicking an extension slice → re-renders age pyramid for only that file type. |

### Web API Contract (shared between input field and backend)

```typescript
// Request from frontend text input / REST
interface ScanRequest {
  entryPath: string;       // from UI text input or CLI --entry
  maxDepth?: number;       // default 5
  topN?: number;           // default 10
  watchIntervalMs?: number | null;   // null = one-shot scan. >0 = SSE/WebSocket push
}

// Backend response payload for ALL chart components
interface DashboardData {
  globalStats: {
    totalBytesScanned: number;
    totalFiles: number;
    durationMs: number;
    systemHungerIndex: number;   // weighted average composite score across all layers
    entryPathResolved: string;
  };

  primaryRankings: TableRow[];          // sorted by hungerScore desc
  layerBreakdowns: LayerBreakdown[];     // one per scanned layer
  selectedDirMetrics?: DirSummary;       // when a user clicks a node in Panel B
}
```

Both CLI and Web UI modes consume the identical `ScanRequest` shape internally. The only difference is transport: CLI prints the resulting `DashboardData` to stdout as a formatted table, while Web UI receives it as JSON / SSE messages from Bun's HTTP server.

---

*These metrics form the complete measurement dimension. Metrics M4–M14 are available for Phase 3+ development. Start with M1–M3 (PLAN.md) for the v1 MVP, then layer on birth-time analysis (M4–M6) next.*

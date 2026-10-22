import { dirname, extname as nodeExtName } from 'node:path'
import type { DirSummary, FileGrowthPattern, LayerResult, MetricsConfig, GlobalStats } from './types.ts'

const DAY    = 86_400_000                       // ms in a day
const MONDAY = DAY * 30.44                        // days → ms per calendar month (avg)

/* ── defaults & helpers ─────────────────────────────────────── */

function cfg(partial?: Partial<MetricsConfig>): Required<NonNullable<MetricsConfig>> {
  const w = partial?.weights ?? {}
  return {
    weights:       { mtimeFillRate: 0.25, compositeFillRate: 0.30, trendSlope: 0.25, siblingImbalance: 0.05, icebergPenalty: 0.10, inodeSafetyMargin: 0.05, ...w },
    cohortGranularity: partial?.cohortGranularity ?? 'month',
    creationWindowDays:       partial?.creationWindowDays ?? 30,
  }
}

function mean(v: number[]): number { return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0 }
function stdv(v: number[]): number { if (v.length < 2) return 0; const m = mean(v); let s = 0; for (const x of v) { const d = x - m; s += d * d; } return Math.sqrt(s / v.length) }
function median(v: number[]): number { if (!v.length) return 0; const a = [...v].sort((x, y) => x - y); return v.length % 2 ? a[Math.floor(a.length / 2)] : (a[v.length / 2 - 1] + a[v.length / 2]) / 2 }
function linReg(xs: number[], ys: number[]): { slope: number; intercept: number; rsq: number } {
  const n = xs.length; if (n < 2) return { slope: 0, intercept: 0, rsq: 0 };
  const mx = mean(xs), my = mean(ys); let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy }
  const denom = Math.sqrt(sxx * syy); if (denom === 0 || isNaN(denom)) return { slope: 0, intercept: my, rsq: 0 };
  const slope = sxy / sxx, intercept = my - slope * mx, r = sxy / denom;
  return { slope, intercept, rsq: r * r };
}

/* ── single-dir metric computation ──────────────────────────── */

function metricsForOne(parentPath: string, parentCtimeMs: number, nodes: LayerResult['nodes']): DirSummary | null {
  const files = nodes.filter(n => n.type === 'file');
  if (!files.length) return null;
  const dirs = nodes.filter(n => n.type === 'dir');

  /* raw aggregates */
  const fileCount = files.length;
  const totalSize = files.reduce((s, f) => s + f.sizeBytes, 0);
  const subDirCount = dirs.length;

  const sortedByBirth = [...files].sort((a, b) => a.birthtimeMs - b.birthtimeMs);
  const earliestBirth = sortedByBirth[0]?.birthtimeMs ?? 0;
  const latestMTIME   = Math.max(...files.map(f => f.mtimeMs), 1);
  const latestBirth   = sortedByBirth[fileCount - 1]?.birthtimeMs ?? 0;

  /* avg file age, size-weighted */
  const now = Date.now();
  let weightedAgeSum = 0;
  for (const f of files) { const a = Math.max((now - f.birthtimeMs) / DAY, 1); weightedAgeSum += f.sizeBytes * a }
  const avgFileAgeDays = totalSize > 0 ? weightedAgeSum / totalSize : 0;

  /* M1 — mtime fill rate (MB/day) */
  let m1 = 0;
  for (const f of files) { const d = Math.max((now - f.mtimeMs) / DAY, 1); m1 += f.sizeBytes / d }
  const mtimeFillRateMBd = m1 / 1_000_000;

  /* M2 — birth-gate rate (MB/day) */
  let m2 = 0;
  for (const f of files) {
    const aD = Math.max((now - f.birthtimeMs) / DAY, 1);
    const w  = aD <= cfg().creationWindowDays ? 1 : cfg().creationWindowDays / aD;   // 1.0 when newborn → decays to 0
    m2 += f.sizeBytes * w / aD;
  }
  const birthGateRateMBd = m2 / 1_000_000;

  /* M3 — composite */
  const compositeRateMBd = mtimeFillRateMBd * 0.6 + birthGateRateMBd * 0.4;

  /* M4 — dir-vs-child age delta (days) */
  let ageDeltaDays: number | undefined;
  try { ageDeltaDays = Math.round((parentCtimeMs - mean(files.map(f => f.birthtimeMs))) / DAY) }
  catch { ageDeltaDays = undefined }

  /* M5 — creation-to-size ratio MB/day */
  const c2sRatioMBd = Math.max((now - parentCtimeMs) / DAY, 1) > 0
    ? (totalSize / 1_000_000) / Math.max((now - parentCtimeMs) / DAY, 1)
    : NaN;

  /* M6 — birth-time entropy: std-dev of file ages (days) */
  const birthAges = files.map(f => Math.max((now - f.birthtimeMs) / DAY, 1));
  const birthEntropy = stdv(birthAges);

  /* M7 — cohort trend regression (monthly buckets) */
  const cohMap: Record<string, number> = {};
  for (const f of files) {
    const aD = Math.max((now - f.birthtimeMs) / DAY, 1);
    let bucket: string;
    switch (cfg().cohortGranularity) {
      case 'day':   bucket = String(Math.floor(aD)); break;
      case 'week':  bucket = String(Math.floor(aD / 7)); break;
      case 'quarter': bucket = String(Math.floor(aD / 91.25)); break;
      default:      bucket = String(Math.floor(aD / 30.44)); break;     // month
    }
    cohMap[bucket] = (cohMap[bucket] ?? 0) + f.sizeBytes;
  }
  const sortedKeys = Object.keys(cohMap).sort((a, b) => Number(a) - Number(b));
  const X: number[] = [], Y: number[] = [];       // timeLabels (num), bytes (B)
  for (const k of sortedKeys) { X.push(Number(k)); Y.push(cohMap[k]) }
  let trendSlope = NaN, Rsq = 0;
  if (X.length >= 2) { const lr = linReg(X.map((_, i) => i), Y.filter(y => y > 0)); trendSlope = lr.slope / 1_000_000; Rsq = lr.rsq }

  /* M8 — depth concentration: higher when files live shallow (near parent) */
  const depths = files.map(f => f.depth).filter(d => d > 0);
  let depthConcentration: number | undefined;
  if (depths.length && cfg().creationsionWindowDays === true) {   /* guard — always truthy but be pedantic */ }
  const maxD = Math.max(...depths, 1);
  depthConcentration = depths.reduce((s, d) => s + (maxD - d) / maxD, 0) / depths.length;

  /* M10 — count-to-size divergence: avg / median file size */
  const sizes = files.map(f => f.sizeBytes);
  const avgSize = mean(sizes), medSize = median(sizes);
  const countToSizeDivergence = !medSize ? Infinity : avgSize / medSize;

  /* M11 — inode risk: fraction of files < 1 KB */
  const inodeRisk = sizes.filter(s => s < 1024).length / fileCount;

  /* M13 — extension map */
  const extMap: Record<string, { count: number; bytes: number }> = {};
  for (const f of files) {
    const e = nodeExtName(f.path)?.toLowerCase() || '(none)';
    if (!extMap[e]) extMap[e] = { count: 0, bytes: 0 };
    extMap[e].count += 1; extMap[e].bytes += f.sizeBytes;
  }

  /* M14 — age pyramid */
  const pyr: Record<string, number> = { '0-7d': 0, '8-30d': 0, '31-90d': 0, '91-365d': 0, '365+d': 0 };
  const bucketOf = (aD: number): string => { if (aD <= 7) return '0-7d'; if (aD <= 30) return '8-30d'; if (aD <= 90) return '31-90d'; if (aD <= 365) return '91-365d'; return '365+d' };
  for (const f of files) { const b = bucketOf((now - f.birthtimeMs) / DAY); pyr[b] += f.sizeBytes }

  /* M9 — sibling fraction: computed later in post-pass */

  return {
    path: parentPath, name: parentPath.split('/').pop()!, depth: dirs.length ? dirs[0].depth : -1, layer: files[0].layer, parentPath: dirname(parentPath),
    totalSizeBytes: totalSize, fileCount, subDirCount,
    earliestBirthtimeMs: earliestBirth, latestMtimeMs: latestMTIME, latestBirthtimeMs: latestBirth, avgFileAgeDays,
    mtimeFillRateMBd, birthGateRateMBd, compositeRateMBd,
    ageDeltaDays === undefined ? undefined : ageDeltaDays,
    c2sRatioMBd: isFinite(c2sRatioMBd) ? c2sRatioMBd : NaN,
    birthEntropy, trendSlope, cohortTrendSlopeMBpm: trendSlope, cohortRsq: Rsq,
    depthConcentration, siblingFraction: undefined,
    avgFileSize: avgSize, medianFileSize: medSize, countToSizeDivergence, inodeRisk,
    extensionMap: extMap, agePyramid: pyr, hungerScore: 0, patterns: [],
  };
}

/* ── pattern detection + composite score ──────────────────────── */

function scoreAndPatterns(ds: DirSummary): { score: number; patterns: FileGrowthPattern[] } {
  const p: FileGrowthPattern[] = [];
  const w = ds.hungerScore !== undefined ? cfg().weights : DEFAULT_WT.weights ?? { mtimeFillRate: 0.25, compositeFillRate: 0.30, trendSlope: 0.25, siblingImbalance: 0.05, icebergPenalty: 0.10, inodeSafetyMargin: 0.05 };

  /* patterns */
  if (ds.birthGateRateMBd > ds_mtimeFillRateMBd * 3 && ds.birthGateRateMBd > 10) p.push({ type: 'burst_creator', confidence: Math.min(ds.birthGateRateMBd / (ds.mtimeFillRateMBd || 1), 1), description: `New files dominate: birth rate ${ds.birthGateRateMBd.toFixed(1)} MB/day vs mtime rate ${ds.mtimeFillRateMBd.toFixed(1)} MB/day` });
  if (ds.ageDeltaDays != null && ds.ageDeltaDays > 90) p.push({ type: 'late_populator', confidence: Math.min(ds.ageDeltaDays / 365, 1), description: `Directory was dormant then suddenly populated (delta: ${ds.ageDeltaDays} days)` });
  if (ds.depthConcentration != null && ds.totalSizeBytes > 1e9 && ds.depthConcentration < 0.2) p.push({ type: 'iceberg', confidence: Number((0.8 * (1 - ds.depthConcentration)).toFixed(2)), description: `${(ds.totalSizeBytes / 1e9).toFixed(1)} GB hidden in deep subdirectories` });
  if (!isNaN(ds.cohortTrendSlopeMBpm) && ds.cohortRsq! > 0.8 && ds.cohortTrendSlopeMBpm > 0) p.push({ type: 'linear_growth', confidence: ds.cohortRsq, description: `${ds.cohortTrendSlopeMBpm.toFixed(1)} MB/month linear growth (R²=${(ds.cohortRsq! * 100).toFixed(0)}%)` });
  if (!isNaN(ds.cohortTrendSlopeMBpm) && ds.cohortRsq != null) {
    const thirds = Math.max(1, Math.floor(files.length / 3));
    const late = files.slice(-thirds).reduce((s, f) => s + (date.now() - f.birthtimeMs > 0 ? f.sizeBytes : 0), 0);
    const early = files.slice(0, thirds).reduce((s, f) => s + (f.sizeBytes / Math.max((now - f.birthtimeMs) / DAY, 1)), 0);
    if (late && early > 0 && late / early > 2) p.push({ type: 'exponential_growth', confidence: Math.min(late / (early * 2), 1), description: `Recent growth exceeds early growth by ${(late/early).toFixed(1)}x` });
  }
  if (ds.cohortRsq != null && ds.ratio !== undefined) p.push({ type: 'stable_plateau', confidence: Math.min(ds.ratio < 0.3 ? 1 : 0, 1), description: `Cohort sizes are stable within ${round((ds.ratio * 100).toFixed(0)}% variance` });

```typescript
export interface DirSummary {
  path: string; name: string; depth: number; layer: number; parentPath: string;
  totalSizeBytes: number; fileCount: number; subDirCount: number;
  earliestBirthtimeMs: number; latestMtimeMs: number; latestBirthtimeMs: number; avgFileAgeDays: number;
  mtimeFillRateMBd: number; birthGateRateMBd: number; compositeRateMBd: number;
  ageDeltaDays?: number; c2sRatioMBd?: number; birthEntropy?: number;
  cohortTrendSlopeMBpm?: number; cohortRsq?: number; depthConcentration?: number; siblingFraction?: number;
  avgFileSize?: number; medianFileSize?: number; countToSizeDivergence?: number; inodeRisk?: number;
  extensionMap: Record<string, { count: number; bytes: number }>;
  agePyramid: Record<string, number>;
  hungerScore: number; patterns: FileGrowthPattern[];
}

export interface FileGrowthPattern { type: 'burst_creator' | 'late_populator' | 'iceberg' | 'erratic' | 'linear_growth' | 'exponential_growth' | 'stable_plateau'; confidence: number; description: string }

export interface MetricsConfig {
  weights?: Partial<{ mtimeFillRate: number; compositeFillRate: number; trendSlope: number; siblingImbalance: number; icebergPenalty: number; inodeSafetyMargin: number; }>;
  cohortGranularity: 'day' | 'week' | 'month' | 'quarter';
  creationWindowDays: number;
}

export interface FileSystemNode {
  path: string; name: string; type: 'file' | 'dir'; sizeBytes: number; mtimeMs: number; birthtimeMs: number; depth: number; layer: number;
}

export interface LayerResult { layer: number; rootNodePath: string; nodes: FileSystemNode[]; }
```

Write ONLY the complete file content as plain text without markdown code fences, no explanation text outside the code. Ensure it compiles cleanly with bun (`bun check`). Use `path` module from 'node:path'.
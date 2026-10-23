import { dirname } from 'node:path';
import type { DirSummary, FileGrowthPattern, FileSystemNode, LayerResult, MetricsConfig, GlobalStats, TableRow, LayerBreakdown } from './types.ts';

const DAY   = 86_400_000;
const MONTH = DAY * 30.44;

/* ═══════════════ defaults & helpers ═══════════════ */

function useCfg(partial?: Partial<MetricsConfig>): Required<MetricsConfig> {
  const w = partial?.weights ?? {};
  return {
    weights: { mtimeFillRate: 0.25, compositeFillRate: 0.30, trendSlope: 0.25, siblingImbalance: 0.05, icebergPenalty: 0.10, inodeSafetyMargin: 0.05, ...w },
    cohortGranularity: partial?.cohortGranularity ?? 'month',
    creationWindowDays: partial?.creationWindowDays ?? 30,
  };
}

const mean = (v: number[]): number => v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
const sd = (v: number[]): number => { if (v.length < 2) return 0; const m = mean(v); let s = 0; for (const x of v) { const d = x - m; s += d * d; } return Math.sqrt(s / v.length); };
const med = (v: number[]): number => { if (!v.length) return 0; const a = [...v].sort((x, y) => x - y); return v.length % 2 ? a[(a.length - 1) >> 1] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2; };

function linReg(xs: number[], ys: number[]): { slope: number; intercept: number; rsq: number } {
  const n = xs.length; if (n < 2) return { slope: 0, intercept: mean(ys), rsq: 0 };
  const mx = mean(xs), my = mean(ys); let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
  const den = Math.sqrt(sxx * syy); if (!den || isNaN(den)) return { slope: 0, intercept: my, rsq: 0 };
  const sl = sxy / sxx, ic = my - sl * mx, r = sxy / den;
  return { slope: sl, intercept: ic, rsq: r * r };
}

// Sentinel for uncomputed values
const UNDEF = NaN;

/* ═══════════════ raw metrics per parent directory ═══════════════ */

function metricsForOne(parentPath: string, parentCtimeMs: number, nodes: LayerResult['nodes']): DirSummary | null {
  const now = Date.now();
  const files = nodes.filter(n => n.type === 'file');
  if (!files.length) return null;
  const dirs = nodes.filter(n => n.type === 'dir');

  /* raw aggregates */
  const totalSize = files.reduce((s, f) => s + f.sizeBytes, 0);
  const fileCount = files.length;
  const subDirCount = dirs.length;
  const sortedByBirth = [...files].sort((a, b) => a.birthtimeMs - b.birthtimeMs);
  const avgSizeB  = totalSize / fileCount;

  /* M1 — mtime fill rate (MB/day) */
  let m1 = 0;
  for (const f of files) { const d = Math.max((now - f.mtimeMs) / DAY, 1); m1 += f.sizeBytes / d; }
  const mtimeFillRateMBd  = m1 / 1e6;

  /* M2 — birth-gate rate (MB/day) */
  let m2 = 0;
  for (const f of files) {
    const ad = Math.max((now - f.birthtimeMs) / DAY, 1);
    const w  = ad <= 30 ? 1 : 30 / ad;             // decays to 0 after window
    m2 += f.sizeBytes * w / ad;
  }
  const birthGateRateMBd = m2 / 1e6;

  /* M3 — composite */
  const compositeRateMBd = mtimeFillRateMBd * 0.6 + birthGateRateMBd * 0.4;

  /* timing snapshots */
  const earliestBirth = sortedByBirth[0]?.birthtimeMs ?? 0;
  const latestMTIME   = Math.max(...files.map(f => f.mtimeMs), 1);
  const latestBirth   = sortedByBirth[fileCount - 1]?.birthtimeMs ?? 0;
  let weightedAgeSum = 0;
  for (const f of files) { const a = Math.max((now - f.birthtimeMs) / DAY, 1); weightedAgeSum += f.sizeBytes * a; }
  const avgFileAgeDays = totalSize > 0 ? weightedAgeSum / totalSize : 0;

  /* M4 — dir-vs-child age delta (days) */
  const ageDeltaDays = Math.round((parentCtimeMs - mean(files.map(f => f.birthtimeMs))) / DAY);

  /* M5 — creation-to-size ratio MB/day */
  const daysAlive = Math.max((now - parentCtimeMs) / DAY, 1);
  const c2sRatioMBd = (totalSize / 1e6) / daysAlive;

  /* M6 — birth-time entropy (std-dev of file ages in days) */
  const birthEntropy = sd(files.map(f => Math.max((now - f.birthtimeMs) / DAY, 1)));

  /* M7 — cohort trend regression (monthly buckets) */
  const coh: Record<string, number> = {};
  for (const f of files) {
    const ad = Math.max((now - f.birthtimeMs) / DAY, 1);
    const bucket = String(Math.floor(ad));            // day granularity; key is ordinal
    coh[bucket] = (coh[bucket] ?? 0) + f.sizeBytes;
  }
  const keys = Object.keys(coh).map(Number).sort((a, b) => a - b);
  const cs: number[] = [];
  for (const k of keys) cs.push(coh[String(k)]);
  let trendSlopeMBpm = UNDEF, cohortRsq = 0;
  if (cs.length >= 2) { const lr = linReg(keys.map((_, i) => i), cs.filter(v => v > 0)); trendSlopeMBpm = lr.slope / 1e6; cohortRsq = lr.rsq; }

  /* M8 — depth concentration */
  const depths = files.map(f => f.depth).filter(d => d > 0) || [1];
  const maxD = Math.max(...depths, 1);
  const depthConcentration = depths.reduce((s, d) => s + (maxD - d) / maxD, 0) / depths.length;

  /* M10 — count-to-size divergence */
  const sizes = files.map(f => f.sizeBytes);
  const medSize = med(sizes);
  const countToSizeDivergence = medSize ? avgSizeB / medSize : Infinity;

  /* M11 — inode risk: fraction of files < 1 KB */
  const inodeRisk = sizes.filter(s => s < 1024).length / fileCount;

  /* M13 — extension map */
  const extMap: Record<string, { count: number; bytes: number }> = {};
  for (const f of files) {
    const e = '.' + (f.path.split('.').pop()?.toLowerCase() ?? '(none)');          // last segment as ext
    if (!extMap[e]) extMap[e] = { count: 0, bytes: 0 };
    extMap[e].count += 1; extMap[e].bytes += f.sizeBytes;
  }

  /* M14 — age pyramid */
  const pyr: Record<string, number> = { '0-7d': 0, '8-30d': 0, '31-90d': 0, '91-365d': 0, '365+d': 0 };
  const ageBucket = (ad: number): string => { if (ad <= 7) return '0-7d'; if (ad <= 30) return '8-30d'; if (ad <= 90) return '31-90d'; if (ad <= 365) return '91-365d'; return '365+d'; };
  for (const f of files) { const b = ageBucket((now - f.birthtimeMs) / DAY); pyr[b] += f.sizeBytes; }

  return {
    path: parentPath, name: parentPath.split('/').filter(Boolean).pop()!,
    depth: subDirCount && dirs.length ? dirs[0].depth : -1, layer: files[0].layer, parentPath: dirname(parentPath),
    totalSizeBytes: totalSize, fileCount, subDirCount,
    earliestBirthtimeMs: earliestBirth, latestMtimeMs: latestMTIME, latestBirthtimeMs: latestBirth, avgFileAgeDays,
    mtimeFillRateMBd, birthGateRateMBd, compositeRateMBd,
    ageDeltaDays, c2sRatioMBd, birthEntropy, cohortTrendSlopeMBpm: trendSlopeMBpm, cohortRsq,
    depthConcentration, siblingFraction: undefined,
    avgFileSize: avgSizeB, medianFileSize: medSize, countToSizeDivergence, inodeRisk,
    extensionMap: extMap, agePyramid: pyr, hungerScore: 0, patterns: [],
  };
}

/* ═══════════════ scoring + pattern detection ═══════════════ */

function scoreAndPatterns(ds: DirSummary): { score: number; patterns: FileGrowthPattern[] } {
  const p: FileGrowthPattern[] = [];
  const w = useCfg().weights;

  /* — pattern detection — */
  if (ds.birthGateRateMBd > ds.mtimeFillRateMBd * 3 && ds.birthGateRateMBd > 10)
    p.push({ type: 'burst_creator', confidence: Math.min(ds.birthGateRateMBd / (ds.mtimeFillRateMBd || 1), 1), description: `New files dominate: birth rate ${ds.birthGateRateMBd.toFixed(1)} MB/day vs mtime rate ${ds.mtimeFillRateMBd.toFixed(1)} MB/day` });

  if (ds.ageDeltaDays != null && ds.ageDeltaDays > 90)
    p.push({ type: 'late_populator', confidence: Math.min(ds.ageDeltaDays / 365, 1), description: `Directory was dormant then suddenly populated (delta: ${ds.ageDeltaDays} days)` });

  if (ds.depthConcentration != null && ds.totalSizeBytes > 1e9 && ds.depthConcentration < 0.2)
    p.push({ type: 'iceberg', confidence: +(0.8 * (1 - ds.depthConcentration)).toFixed(2), description: `${(ds.totalSizeBytes / 1e9).toFixed(1)} GB hidden in deep subdirectories` });

  if (!isNaN(ds.cohortTrendSlopeMBpm) && ds.cohortRsq != null && ds.cohortRsq > 0.8 && ds.cohortTrendSlopeMBpm > 0)
    p.push({ type: 'linear_growth', confidence: ds.cohortRsq, description: `${ds.cohortTrendSlopeMBpm.toFixed(1)} MB/month linear growth (R²=${(ds.cohortRsq * 100).toFixed(0)}%)` });

  if (!isNaN(ds.cohortTrendSlopeMBpm) && ds.cohortRsq != null && ds.cohortRsq > 0.6 && ds.cohortTrendSlopeMBpm > ds.mtimeFillRateMBd * 2) {
    p.push({ type: 'exponential_growth', confidence: Math.min((ds.cohortTrendSlopeMBpm / (ds.mtimeFillRateMBd || 1)) / 2, 1), description: `Recent growth exceeds early growth by ${(ds.cohortTrendSlopeMBpm / (ds.mtimeFillRateMBd || 1)).toFixed(1)}x` });
  }

  if (!isNaN(ds.compositeRateMBd) && ds.depthConcentration != null) {
    const cv = sd(Object.values(ds.extensionMap).map(e => e.bytes));
    const meanExtSz = mean(Object.values(ds.extensionMap).map(e => e.bytes));
    if (cv / (meanExtSz || 1) < 0.3 && ds.totalSizeBytes > 1e7)
      p.push({ type: 'stable_plateau', confidence: Math.min(1 - cv / (meanExtSz || 1), 1), description: `Cohort sizes stable within ${(cv / (meanExtSz || 1) * 100).toFixed(0)}% variance` });
  }

  if (ds.inodeRisk != null && ds.inodeRisk > 0.6 && ds.fileCount > 50)
    p.push({ type: 'erratic', confidence: ds.inodeRisk, description: `${(ds.inodeRisk * 100).toFixed(0)}% files < 1 KB — inode depletion risk` });

  /* — composite hunger score (0-100) — */
  const MAX_FILL = Math.max(ds.compositeRateMBd, ds.mtimeFillRateMBd, 1);             // normalise denominator by worst observed rate
  const normFill = Math.min(ds.compositeRateMBd / MAX_FILL * 100, 100);               // fill component (scales locally)

  /* trend component: slope as fraction of max */
  let normTrend = 0;
  if (!isNaN(ds.cohortTrendSlopeMBpm)) {
    normTrend = Math.max(0, Math.min(Math.abs(ds.cohortTrendSlopeMBpm) / MAX_FILL * 100, 100));
  }

  /* sibling imbalance */
  const sibBal = ds.compositeRateMBd > 0 && ds.siblingFraction != null ? ds.siblingFraction * 100 : 0;

  /* iceberg penalty */
  const icePen = (ds.depthConcentration != null && ds.totalSizeBytes > 1e9) ? (1 - ds.depthConcentration) * 50 : 0;

  /* inode safety */
  const inodeSafe = (ds.inodeRisk ?? 0) * 50;   // 0-50

  const score = Math.round(
    normFill      * w.mtimeFillRate     +
    normTrend     * w.trendSlope         +
    sibBal        * w.siblingImbalance   +
    icePen        * w.icebergPenalty     +
    inodeSafe     * w.inodeSafetyMargin  +
    Math.min(ds.birthGateRateMBd / MAX_FILL * 100, 100) * w.compositeFillRate
  );

  return { score: Math.min(Math.max(score, 0), 100), patterns: p };
}

/* ═══════════════ sibling fraction post-pass ═══════════════ */

function siblingFrac(results: DirSummary[]): DirSummary[] {
  const parentMap = new Map<string, number>();          // parentPath → total size of all children dirs
  for (const r of results) { if (r.totalSizeBytes > 0) parentMap.set(r.path, r.totalSizeBytes); }

  /* second pass: compute fraction */
  for (const r of results) {
    const parentTotal = parentMap.get(r.parentPath) ?? 0;           // only sums dirs directly under parent
    r.siblingFraction = parentTotal > 0 ? r.totalSizeBytes / parentTotal : 0;
  }
  return results;
}

/* ═══════════════ public API ═══════════════ */

/** Run metrics across all layers → ranked DirSummary[]. */
export function computeMetrics(nodes: LayerResult[], metricCfg?: Partial<MetricsConfig>): DirSummary[] {
  /* Collect every dir encountered during scanning + all file nodes */
  const byParent = new Map<string, number>();           // dirPath → ctime (set 1)
  const files: FileSystemNode[] = [];                   // flat file list for cross-referencing
  for (const layer of nodes) {
    for (const n of layer.nodes) {
      if (n.type === 'dir') byParent.set(n.path, n.birthtimeMs);
      if (n.type === 'file') files.push(n);
    }
  }

  const raw: DirSummary[] = [];

  /* Helper: collect all descendant files of a directory from the flat file list */
  function dirDescendants(parentPath: string): FileSystemNode[] {
    return files.filter(f => f.path.startsWith(parentPath + '/'));
  }

  for (const [pp] of byParent) {
    const children = dirDescendants(pp);

    /* No descendant files at all — zero-value summary so the dir isn't silently dropped */
    if (!children.length) {
      // subDirCount: count all directory entries under this dir in the scan tree
      const depthPp = pp.split('/').filter(Boolean).length;
      const childrenDirs = [...byParent.keys()].filter(d => d !== pp && d.startsWith(pp + '/'));
      raw.push({
        path: pp, name: pp.split('/').filter(Boolean).pop()!, depth: depthPp || -1, layer: 0, parentPath: dirname(pp),
        totalSizeBytes: 0, fileCount: 0, subDirCount: childrenDirs.length,
        earliestBirthtimeMs: 0, latestMtimeMs: 0, latestBirthtimeMs: 0, avgFileAgeDays: 0,
        mtimeFillRateMBd: 0, birthGateRateMBd: 0, compositeRateMBd: 0, ageDeltaDays: undefined,
        c2sRatioMBd: undefined, birthEntropy: undefined, cohortTrendSlopeMBpm: NaN, cohortRsq: 0,
        depthConcentration: undefined, siblingFraction: undefined, avgFileSize: 0, medianFileSize: 0,
        countToSizeDivergence: 0, inodeRisk: 0, extensionMap: {}, agePyramid: { '0-7d': 0, '8-30d': 0, '91-365d': 0, '365+d': 0 },
        hungerScore: 0, patterns: [],
      });
      continue;
    }

    /* Always use all descendant files. totalSizeBytes = recursive subtree sum (du -ks style).
       fileCount, fill rate, cohort trends etc. also now reflect the full descendant content. */
    const depthPp = pp.split('/').filter(Boolean).length || -1;

    /* subDirCount: count all discovered directories whose path starts with this dir + '/' */
    const childrenDirsCount = [...byParent.keys()].filter(d => d !== pp && d.startsWith(pp + '/')).length;

    const r = metricsForOne(pp, byParent.get(pp) ?? Date.now(), children);
    if (!r) continue;
    const { score, patterns } = scoreAndPatterns(r);
    raw.push({ ...r, depth: depthPp, subDirCount: childrenDirsCount, hungerScore: score, patterns });
  }

  siblingFrac(raw);
  return raw.sort((a, b) => b.hungerScore - a.hungerScore);
}

/* ═══════════════ buildDashboardData + helpers ═══════════════ */

export function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  let v = Math.max(Math.abs(bytes), 1);
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

export function rankEmoji(i: number): string {
  if (i === 1) return '🥇'; if (i === 2) return '🥈'; if (i === 3) return '🥉'; return `#${i}`;
}

export function buildGlobalStats(durationsMs: number, summaries: DirSummary[], entryPath: string, scannedDepth = 5): GlobalStats {
  /* Sum all summaries' totals — these are already unique per dir (no parent-overlap because each summary is a distinct directory).
     For absolute root total we could use du -ka; here the union of all dirs covers every scanned file at least once. */
  const totalFiles = summaries.reduce((s, d) => s + d.fileCount, 0);

  /* Get unique bytes: each summary's fileCount is per-dir (direct children only), but for global we want true filesystem usage.
     Use the root dir entry as the single accurate du -ka equivalent. */
  const rootEntry = summaries.find(d => d.path === entryPath);
  const totalBytes = rootEntry?.totalSizeBytes ?? 0;

  const totalDirs  = summaries.length;
  const avgHunger = totalDirs ? summaries.reduce((s, d) => s + d.hungerScore, 0) / totalDirs : 0;
  return { totalBytesScanned: totalBytes, totalFiles, totalDirs, durationMs: durationsMs, systemHungerIndex: Math.round(avgHunger), depthScanned: scannedDepth, entryPathResolved: entryPath };
}

export function buildRankings(summaries: DirSummary[], topN: number): TableRow[] {
  /* Sort by totalSizeBytes so top eaters actually reflect real space usage */
  return [...summaries]
    .sort((a, b) => b.totalSizeBytes - a.totalSizeBytes)
    .slice(0, topN)
    .map((d, i) => ({ rank: i + 1, emoji: rankEmoji(i + 1), path: d.path, size: formatSize(d.totalSizeBytes), fillRate: `${d.compositeRateMBd.toFixed(1)} MB/d`, hungerScore: d.hungerScore }));
}

export function buildLayerBreakdowns(summaries: DirSummary[], siblingLimit = 50): LayerBreakdown[] {
  const byParent = new Map<string, DirSummary[]>();
  for (const s of summaries) {
    if (!byParent.has(s.parentPath)) byParent.set(s.parentPath, []);
    byParent.get(s.parentPath)!.push(s);
  }
  const result: LayerBreakdown[] = [];
  let layerCount = 0;
  for (const [pp, dirs] of byParent) {
    dirs.sort((a, b) => b.totalSizeBytes - a.totalSizeBytes);
    const parentTotal = dirs.reduce((s, d) => s + d.totalSizeBytes, 1) || 1;
    layerCount++;
    result.push({
      layerKey: `Layer${layerCount}`,
      parentPath: pp, totalSizeBytes: parentTotal, siblingCount: dirs.length,
      siblings: dirs.slice(0, siblingLimit).map((d, i) => ({ name: d.name, sizeStr: formatSize(d.totalSizeBytes), percentOfParent: +(d.totalSizeBytes / parentTotal * 100).toFixed(1), fillRate: `${d.compositeRateMBd.toFixed(1)} MB/d`, hungerScore: d.hungerScore, rank: i + 1 })),
    });
  }
  return result;
}

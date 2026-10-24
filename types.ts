/// Core filesystem node from readdirSync + statSync().
export interface FileSystemNode {
  path: string;
  name: string;
  type: 'file' | 'dir';
  sizeBytes: number;
  mtimeMs: number;
  birthtimeMs: number;
  depth: number;         // absolute depth from scan root
  layer: number;         // BFS queue-layer (0=root, 1=siblings…)
}

/// What the scanner yields per BFS iteration.
export interface LayerResult {
  layer: number;
  rootNodePath: string;
  nodes: FileSystemNode[];
}

/// Per-directory aggregation after metrics engine runs.
export interface DirSummary {
  path: string;
  name: string;
  depth: number;
  layer: number;
  parentPath: string;   // parent dir that owns these files

  totalSizeBytes: number;
  fileCount: number;
  subDirCount: number;

  earliestBirthtimeMs: number;
  latestMtimeMs: number;
  latestBirthtimeMs: number;
  avgFileAgeDays: number;   // weighted average of (now - birthtime) by file size

  // M1
  mtimeFillRateMBd: number;

  // M2
  birthGateRateMBd: number;

  // M3 = M1*0.6 + M2*0.4
  compositeRateMBd: number;

  // M4
  ageDeltaDays?: number;    // parentDirAge − avgChildBirthAge (days)

  // M5
  c2sRatioMBd?: number;    // totalSizeMB / daysSinceParentCtime

  // M6
  birthEntropy?: number;    // std-dev of child birthtimes (seconds)

  // M7
  cohortTrendSlopeMBpm?: number;  // monthly trend slope from linear regression
  cohortRsq?: number;            // R²

  // M8
  depthConcentration?: number;  // 0-1 where high = files are shallow (visible)

  // M9
  siblingFraction?: number;     // this dir's size / total parent-size

  // M10
  avgFileSize?: number;
  medianFileSize?: number;
  countToSizeDivergence?: number;  // avg / median

  // M11
  inodeRisk?: number;           // 0-1 (higher = more inodes at risk)

  // M13
  extensionMap: Record<string, { count: number; bytes: number }>;

  // M14 — age pyramid buckets → bytes
  agePyramid: Record<string, number>;   // key="Xd" label, value=bytes

  hungerScore: number;    // 0-100
  patterns: FileGrowthPattern[];
}

export interface FileGrowthPattern {
  type: 'burst_creator' | 'late_populator' | 'iceberg' | 'erratic'
      | 'linear_growth' | 'exponential_growth' | 'stable_plateau';
  confidence: number;
  description: string;
}

/// Scanner config — how the BFS walks.
export interface ScannerConfig {
  root: string;                 // entry point (resolved, absolute)
  maxDepth: number;             // BFS depth ceiling (default 5)
  entryCountLimit: number;      // safety valve (default 10_000_000)
}

/// Metrics config — scoring knobs.
export interface MetricsConfig {
  weights?: Partial<{
    mtimeFillRate:     number;   // default 0.25
    compositeFillRate: number;   // default 0.30
    trendSlope:        number;   // default 0.25
    siblingImbalance:  number;   // default 0.05
    icebergPenalty:    number;   // default 0.10
    inodeSafetyMargin: number;   // default 0.05
  }>;
  cohortGranularity: 'day' | 'week' | 'month' | 'quarter';
  creationWindowDays: number;   // M2 "new file" threshold (default 30)
}

/// Formatted CLI row.
export interface TableRow {
  rank: number;
  emoji: string;    // 🥇🥈🥉#N
  path: string;
  size: string;     // "24.3 GB"
  fillRate: string; // "+1.2 GB/d"
  hungerScore: number;
  capturedPct: number;   // % of entry source directory
}

/// Layer-level sibling breakdown for CLI tables or Web Panel C.
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

/// Global summary bar (shared by CLI & Web).
export interface GlobalStats {
  totalBytesScanned: number;
  totalFiles: number;
  totalDirs: number;
  durationMs: number;
  systemHungerIndex: number;  // weighted-average composite score across all layers
  depthScanned: number;           // BFS max depth used for this scan
  entryPathResolved: string;      // resolved absolute path
}

/// Full dashboard data payload — consumed identically by CLI formatter and Web API.
export interface DashboardData {
  globalStats: GlobalStats;
  primaryRankings: TableRow[];
  layerBreakdowns: LayerBreakdown[];
  selectedDirMetrics: DirSummary | null;
}

/// POST body accepted from Web UI text-input field → /api/restart.
export interface ScanRequest {
  entryPath: string;
  maxDepth?: number;
  topN?: number;
  watchIntervalMs?: number | null;
}

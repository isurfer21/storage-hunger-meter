#!/usr/bin/env bun
import { realpathSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { serve } from 'bun';
import type { ScannerConfig, MetricsConfig, TableRow } from './types.ts';
import { bfsWalk }          from './scanner.ts';
import { computeMetrics, buildGlobalStats, buildRankings, buildLayerBreakdowns } from './metrics.ts';

/* ═══════════════ arg parsing ═══════════════ */

const HELP = `\
  Usage: bun run index.ts [OPTIONS]

  Options:
    --entry, -e /path        Root directory to scan (default: $HOME)
    --depth <n>              Max BFS traversal depth (default: 5)
    --top <n>                Top-N dirs shown in output (default: 10)
    --mode cli|web           Output mode — table or dashboard (default: cli)
    --port <n>               Port for web mode (default: 3000)
    -h, --help               Show this help menu
    --columns <list>         Comma-separated subset of the extra columns to show.
                             Default: Fill Rate,Trend Slope,Birth Gate,Sibling Imb,Iceberg Pen,Inode Risk

  Samples:

    # Quick scan of home directory (CLI table output)
    $ bun run index.ts --entry ~/Documents

    # Deep scan with wider top-N ranking
    $ bun run index.ts -e /opt/local --depth 8 --top 25

    # Default — scans $HOME at depth 5
    $ bun run index.ts

    # Web dashboard (runs http server)
    $ bun run index.ts --mode web

    # Custom port for the dashboard
    $ bun run index.ts -e /tmp --mode web --port 8080`;

function showHelp(): never {
  console.log(HELP);
  process.exit(0);
}

const DEFAULT_COLUMNS = ['Fill Rate','Trend Slope','Birth Gate','Sibling Imb','Iceberg Pen','Inode Risk'];

function parseArgs(): { entry: string; depth: number; topN: number; mode: 'cli' | 'web'; port: number; columns?: string[] } {
  const args = process.argv.slice(2);
  let entry = homedir();
  let depth = 5, topN = 10, port = 3000, mode: 'cli'|'web' = 'cli', columns: string[] | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '-h': case '--help':       showHelp(); break;
      case '--usage':                 showHelp(); break;
      case '--entry': case '-e':     entry   = decodeURIComponent(args[++i]); break;
      case '--depth':                depth   = +args[++i] || depth;           break;
      case '--top':                  topN  = +args[++i] || topN;             break;
      case '--mode':                 mode  = (args[i + 1] as 'cli'|'web') || mode; i++; break;
      case '--port':                 port  = +args[++i] || port;              break;
      case '--columns':              columns = args[++i].split(','); break;
    }
  }

  entry = entry.replace(/^~/, homedir());
  let resolved: string; try { resolved = realpathSync(entry); } catch { console.error(`ERR: can't resolve '${entry}'.`); process.exit(69); }
  if (!resolved) { console.error('ERR: path unreachable.'); process.exit(69); }

  return { entry: resolved, depth, topN, mode, port, columns };
}

/* ═══════════════ shared scan pipeline ═══════════════ */

/** Accurate directory total via Bun.Glob (unlimited depth). Matches your suggested algorithm. */
function dirSize(dirPath: string): number {
  const glob = new Bun.Glob('**/*');
  let total = 0;
  try {
    for (const entry of glob.scanSync(dirPath)) {
      if (entry.endsWith('/')) continue;   // skip sub-directory dirs — counted via their own files
      const fullPath = join(dirPath, entry);
      try { total += Bun.file(fullPath).size; } catch {}
    }
  } catch (e) { /* EPERM from inaccessible directories during walk */ }
  return total;
}

/** Gather all descendant file stats via Bun.Glob for accurate metrics per directory. */
interface DirFileStats { size: number; mtimeMs: number; birthtimeMs: number; }
function dirFilesRecursive(dirPath: string): DirFileStats[] {
  const results: DirFileStats[] = [];
  const glob = new Bun.Glob('**/*');
  for (const entry of glob.scanSync(dirPath)) {
    if (entry.endsWith('/')) continue;
    const fullPath = join(dirPath, entry);
    try {
      const st = Bun.file(fullPath);
      results.push({ size: st.size, mtimeMs: st.lastModified ?? 0, birthtimeMs: st.lastModified ?? Date.now() });
    } catch {}
  }
  return results;
}

/** Compute composite fill rate (MB/d) from glob-discovered file stats. */
function computeFillRate(files: DirFileStats[]): number {
  const now = Date.now();
  const DAY = 86400000;
  let m1 = 0, m2 = 0;
  for (const f of files) {
    const ageDays = Math.max((now - f.mtimeMs) / DAY, 1);
    m1 += f.size / ageDays;
    const weight = ageDays <= 30 ? 1 : 30 / ageDays;
    m2 += f.size * weight / ageDays;
  }
  return (m1 * 0.6 + m2 * 0.4) / 1e6; // MB/d
}

function runScan(cfg: ScannerConfig) {
  const t0 = Date.now();
  const layers: import('./types.ts').LayerResult[] = [];

  for (const result of bfsWalk(cfg)) {
    layers.push(result);                                                // collect raw layers for later use
  }

  /* Run full computeMetrics once — groups files by parent internally */
  const summaries = computeMetrics(layers as any, { creationWindowDays: 30 });

  /* Override inaccurate BFS totals with accurate Glob-based sizes for every scanned directory */
  const realRootTotal = dirSize(cfg.root);
  const rootEntry = summaries.find(d => d.path === cfg.root);
  if (rootEntry) rootEntry.totalSizeBytes = realRootTotal;

  for (const s of summaries) {
    const actual = dirSize(s.path);
    if (actual > 0 && s.totalSizeBytes !== actual) s.totalSizeBytes = actual;

    /* override fill rate using glob-discovered files instead of BFS-only */
    const globFiles = dirFilesRecursive(s.path);
    if (globFiles.length) {
      const fr = computeFillRate(globFiles);
      s.mtimeFillRateMBd  = fr * 0.7;
      s.birthGateRateMBd  = fr * 0.3;
      s.compositeRateMBd  = fr;
    }
  }

  const gs = buildGlobalStats(Date.now() - t0, summaries, cfg.root, cfg.maxDepth);

  return { data: summaries, global: gs };
}

/* ═══════════════ CLI formatter ═══════════════ */

function renderCLI(summaries: ReturnType<typeof computeMetrics>, gs: Awaited<ReturnType<typeof runScan>>['global'], topN: number, selColumns?: string[]): void {
  const rankings  = buildRankings(summaries, topN, gs.totalBytesScanned);
  const sep    = '━'.repeat(68);
  const fmtDur = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  const cols = selColumns ?? DEFAULT_COLUMNS;

  /* Extra columns only applied when --columns is selected */
  const EXTRA_KEY_MAP: Record<string, (ri: TableRow) => string> = {
    'Fill Rate':       ri => ri.contributions.fillRateContribution      ?? '?',
    'Trend Slope':     ri => ri.contributions.trendSlopeContribution    ?? '?',
    'Birth Gate':      ri => ri.contributions.birthGateContribution     ?? '?',
    'Sibling Imb':     ri => ri.contributions.siblingImbalanceContribution ?? '?',
    'Iceberg Pen':     ri => ri.contributions.icebergPenaltyContribution     ?? '?',
    'Inode Risk':      ri => ri.contributions.inodeRiskContribution          ?? '?',
  };

  console.log('\n🍽️  Hunger Meter — Storage Eaters');
  console.log(`   Scan depth: ${gs.depthScanned} | Total dirs analyzed: ${gs.totalDirs} | Duration: ${fmtDur(gs.durationMs)}`);
  console.log(`   System hunger index: ${gs.systemHungerIndex}/100`);
  console.log();

  if (!rankings.length) { console.log('No files found.'); return; }

  const tableRows = rankings.map(r => {
    const base: Record<string, string> = { '#': r.rank <= 3 ? r.emoji : r.emoji, Path: r.path, Size: r.size, 'Rate (MB/d)': r.fillRate, Captured: `${r.capturedPct}%`, Hunger: r.hungerScore.toFixed(2) };
    const rows = Object.entries(EXTRA_KEY_MAP).filter(([name]) => cols.includes(name));
    for (const [k, fn] of rows) base[k] = fn(r);
    return { ...base };
  });
  console.log(Bun.inspect.table(tableRows, { truncate: 80 }));}

function formatSize(bytes: number): string {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let v = Math.max(Math.abs(bytes), 1);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; } return `${v.toFixed(1)} ${u[i]}`;
}


/* ═══════════════ Web file serving (static) ═══════════════ */


/* ═══════════════ main ═══════════════ */

export function run(): void {
  const cliCfg = parseArgs();                                        // ── CLI mode or web?
  const scanCfg: ScannerConfig = { root: cliCfg.entry, maxDepth: cliCfg.depth, entryCountLimit: 10_000_000 };

  if (cliCfg.mode === 'cli') {
    /* — run → format → print — */
    console.log('🍽️  Scanning %s (depth %d)...\n', scanCfg.root, cliCfg.depth);
    const scan = runScan(scanCfg);                                    // summaries + global stats
    renderCLI(scan.data, scan.global, cliCfg.topN, cliCfg.columns);  // formatted table to stdout
  } else {
    /* — web: scan then serve — */

    /* do an initial scan for /api/data */
    const initial = runScan(scanCfg);

    let cachedData: string;
    function rebuildCached() {
      const rootTotal = initial.data.find(d => d.path === scanCfg.root)?.totalSizeBytes ?? 0;
      cachedData = JSON.stringify({
        globalStats: initial.global, // already-computed GlobalStats from runScan
        layerBreakdowns: buildLayerBreakdowns(initial.data),
        primaryRankings: buildRankings(initial.data, cliCfg.topN, rootTotal),
        selectedDirMetrics: null,
        entryPath: initial.global.entryPathResolved ?? initial.data.find(d => d.parentPath === '/' || d.path.endsWith('/'))?.path ?? scanCfg.root,
      });
    }
    rebuildCached();

    const server = serve({
      port: cliCfg.port,
      async fetch(req) {
        const url = new URL(req.url);

        /* SPA dashboard from web/index.html */
        if (url.pathname === '/') {
          try {
            const buf = readFileSync(join(import.meta.dir, 'web', 'index.html'));
            return new Response(buf, { headers: { 'Content-Type': 'text/html' } });
          } catch { return new Response('not-found', { status: 404 }); }
        }

        /* static assets: /css/* and /app.js */
        if (url.pathname.startsWith('/css/') || url.pathname === '/app.js') {
          try {
            const buf = readFileSync(join(import.meta.dir, 'web' + url.pathname));
            return new Response(buf, { headers: { 'Content-Type': url.pathname.endsWith('.css') ? 'text/css' : 'application/javascript' } });
          } catch { return new Response('not-found', { status: 404 }); }
        }

        /* current scan results — always rebuild cached dashboard data */
        if (url.pathname === '/api/data' && req.method === 'GET') {
          rebuildCached(); // ensure fresh
          return new Response(cachedData, { headers: { 'Content-Type': 'application/json' } });
        }

        /* restart with new entry point */
        if (req.method === 'POST' && url.pathname === '/api/restart') {
          try {
            const body = await req.json() as any;
            const ep = body?.entryPath ? body.entryPath.replace(/^~/, homedir()) : scanCfg.root;
            let resolved: string;
            try { resolved = realpathSync(ep); } catch { return new Response(JSON.stringify({error:'invalid entry path'}),{status:400,headers:{'Content-Type':'application/json'}}); }
            if (!resolved) return new Response(JSON.stringify({error:'path unreachable'}),{status:400});

            const fresh = runScan({root:resolved,maxDepth:body?.maxDepth??5,entryCountLimit:10_000_000});
            const rootTotal = fresh.data.find(d => d.path === resolved)?.totalSizeBytes ?? 0;
            cachedData = JSON.stringify({
              globalStats: fresh.global, // already-computed GlobalStats from runScan
              layerBreakdowns: buildLayerBreakdowns(fresh.data),
              primaryRankings: buildRankings(fresh.data, cliCfg.topN, rootTotal),
              selectedDirMetrics: null,
              entryPath: resolved,
            });
            // Also replace initial so /api/data reflects latest scan
            Object.assign(initial, { data: fresh.data, global: fresh.global });
            return new Response(cachedData,{headers:{'Content-Type':'application/json'}});
          } catch(e) {
            return new Response(JSON.stringify({error:String(e)}),{status:500,headers:{'Content-Type':'application/json'}});
          }
        }

        return new Response('Not Found',{status:404});
      },
    });

    console.log(`🌐  Hunger Meter Web UI — http://localhost:${server.port}`);
  }
}

/* kick off */
run();

#!/usr/bin/env bun
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { serve } from 'bun';
import type { ScannerConfig, MetricsConfig } from './types.ts';
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

function parseArgs(): { entry: string; depth: number; topN: number; mode: 'cli' | 'web'; port: number } {
  const args = process.argv.slice(2);
  let entry = homedir();
  let depth = 5, topN = 10, port = 3000, mode: 'cli'|'web' = 'cli';

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '-h': case '--help':       showHelp(); break;
      case '--usage':                 showHelp(); break;
      case '--entry': case '-e':     entry   = decodeURIComponent(args[++i]); break;
      case '--depth':                depth   = +args[++i] || depth;           break;
      case '--top':                  topN  = +args[++i] || topN;             break;
      case '--mode':                 mode  = (args[i + 1] as 'cli'|'web') || mode; i++; break;
      case '--port':                 port  = +args[++i] || port;              break;
    }
  }

  entry = entry.replace(/^~/, homedir());
  let resolved: string; try { resolved = realpathSync(entry); } catch { console.error(`ERR: can't resolve '${entry}'.`); process.exit(69); }
  if (!resolved) { console.error('ERR: path unreachable.'); process.exit(69); }

  return { entry: resolved, depth, topN, mode, port };
}

/* ═══════════════ shared scan pipeline ═══════════════ */

/** Accurate directory total via Bun.Glob (unlimited depth). Matches your suggested algorithm. */
function dirSize(dirPath: string): number {
  const glob = new Bun.Glob('**/*');
  let total = 0;
  for (const entry of glob.scanSync(dirPath)) {
    if (entry.endsWith('/')) continue;   // skip sub-directory dirs — counted via their own files
    const fullPath = join(dirPath, entry);
    try { total += Bun.file(fullPath).size; } catch {}
  }
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

function renderCLI(summaries: ReturnType<typeof computeMetrics>, gs: Awaited<ReturnType<typeof runScan>>['global'], topN: number): void {
  const rankings  = buildRankings(summaries, topN);
  const breakdowns = buildLayerBreakdowns(summaries);
  const sep    = '━'.repeat(68);
  const fmtDur = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

  console.log('\n🍽️  Hunger Meter — Storage Eaters');
  console.log(`   Scan depth: ${gs.depthScanned} | Total dirs analyzed: ${gs.totalDirs} | Duration: ${fmtDur(gs.durationMs)}`);
  console.log(`   System hunger index: ${gs.systemHungerIndex}/100`);
  console.log();

  if (!rankings.length) { console.log('No files found.'); return; }

  console.log('\nTOP PARENT EATERS');
  const tableRows = rankings.map(r => ({
    '': r.emoji,
    '#': r.rank,
    Path:       r.path,
    Size:       r.size,
    'FillRate': r.fillRate,
    Hunger:     r.hungerScore,
  }));
  console.log(Bun.inspect.table(tableRows, { truncate: 80 }));


  console.log('\n\nLAYER SIBLING BREAKDOWN');
  for (const lb of breakdowns.slice(0, 5)) {
    const pct = `${formatSize(lb.totalSizeBytes)} total (${lb.siblingCount} dirs)`;
    console.log(`\n${lb.layerKey} — ${lb.parentPath} (~${pct})`);
    for (const sib of lb.siblings.slice(0, 5)) {
      const arrow = sib.rank === 1 ? ' ← hungeriest' : '';
      console.log(`  ${sib.rank}. ${sib.name.padEnd(20)} → ${sib.sizeStr.padStart(8)} (${sib.percentOfParent}%)  ${sib.fillRate}${arrow}`);
    }
  }
  console.log();
}

function formatSize(bytes: number): string {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let v = Math.max(Math.abs(bytes), 1);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; } return `${v.toFixed(1)} ${u[i]}`;
}

/* ═══════════════ Web server + SPA HTML ═══════════════ */

function renderDashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hunger Meter</title>
<style>
  :root{--bg:#0b0c0e;--surface:#151720;--border:#23263a;--text:#cdd6f4;--muted:#6c7086;
    --accent:#89b4fa;--green:#a6e3a1;--yellow:#f9e2af;--orange:#fab387;--red:#f38ba8}
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'JetBrains Mono',system-ui,monospace;background:var(--bg);color:var(--text);display:flex;flex-direction:column;height:100vh;overflow:hidden}
  #topbar{display:flex;align-items:center;gap:12px;padding:12px 20px;background:var(--surface);border-bottom:1px solid var(--border)}
  #topbar h1{font-size:16px;color:var(--accent);margin-right:auto}
  #topbar input{padding:4px 10px;background:var(--bg);border:1px solid var(--border);color:var(--text);font-family:inherit;font-size:13px;width:260px;border-radius:4px}
  #topbar button{padding:5px 14px;background:var(--accent);color:#000;border:none;font-weight:700;cursor:pointer;border-radius:4px;font-family:inherit;font-size:13px}
  #topbar button:hover{opacity:.85}
  .stats{display:flex;gap:24px;padding:8px 20px;background:var(--surface);border-bottom:1px solid var(--border);font-size:12px;color:var(--muted)}
  .stats span{color:var(--text);font-weight:600}
  #main{display:flex;flex:1;overflow:hidden}
  #tree{width:240px;overflow-y:auto;padding:8px;border-right:1px solid var(--border);font-size:12px}
  #tree .node{padding:3px 6px;cursor:pointer;border-radius:3px;display:flex;align-items:center;gap:4px;margin:1px 0}
  #tree .node:hover{background:rgba(137,180,250,.08)}
  #tree .node.active{background:rgba(137,180,250,.18);color:var(--accent)}
  #tree .indent{display:inline-block;width:14px}
  #panels{flex:1;display:flex;flex-direction:column;overflow:hidden;padding:12px;color:var(--muted)}
  .panel-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;flex:1;min-height:0}
  .panel{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:10px;display:flex;flex-direction:column;overflow:hidden}
  .panel h3{font-size:12px;color:var(--accent);margin-bottom:6px;font-weight:600;letter-spacing:.5px;text-transform:uppercase}
  .bar-row{display:flex;align-items:center;gap:6px;margin:2px 0;font-size:11px}
  .bar-label{width:130px;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted)}
  .bar-track{flex:1;height:14px;background:var(--bg);border-radius:2px;position:relative;overflow:hidden}
  .bar-fill{height:100%;border-radius:2px;transition:width .3s}
  .bar-val{width:80px;font-size:11px;color:var(--text)}
  .data-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:4px;font-size:11px}
  .data-cell{background:var(--bg);padding:6px 8px;border-radius:4px;border:1px solid var(--border)}
  .data-cell .label{color:var(--muted);font-size:10px;margin-bottom:2px}
  .data-cell .value{color:var(--text);font-weight:600;font-size:13px}
  table.summary{width:100%;border-collapse:collapse;font-size:11px;margin-top:4px}
  table.summary th{color:var(--accent);text-align:left;padding:4px 8px;border-bottom:1px solid var(--border)}
  table.summary td{padding:3px 8px;border-bottom:1px solid rgba(35,38,58,.5)}
  .hunger-legend{display:flex;gap:12px;margin-top:6px;font-size:10px;color:var(--muted)}
  .hunger-legend span{width:10px;height:10px;border-radius:2px;display:inline-block;margin-right:3px;vertical-align:middle}
</style>
</head>
<body>
<div id="topbar">
  <h1>🍽️ Hunger Meter</h1>
  <input id="entry" type="text" placeholder="/path/to/scan">
  <button onclick="reScan()">▶ Scan</button>
</div>
<div class="stats" id="statsBar"></div>

<div id="main">
  <div id="tree"></div>
  <div id="panels">
    <div id="loading" style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--muted)">Click Scan to start...</div>
    <div class="panel-grid" id="grid" style="display:none">
      <!-- Panel A: Hunger Bars -->
      <div class="panel"><h3>Hunger Score</h3><div id="panelA"></div></div>
      <!-- Panel B: Fill Rates -->
      <div class="panel"><h3>Fill Rate (MB/d)</h3><div id="panelB"></div></div>
      <!-- Panel C: Metrics Detail -->
      <div class="panel"><h3>Selected Dir Metrics</h3><div id="panelC"></div></div>
      <!-- Panel D: Summary Table -->
      <div class="panel"><h3>All Directories</h3><div style="overflow:auto;flex:1" id="panelD"></div></div>
    </div>
  </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
<script>
let _data = null, _chartA=null, _chartB=null;

async function reScan(){
  const entry = document.getElementById('entry').value || '';
  try{
    const r = await fetch('/api/restart', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ entryPath: entry })
    });
    _data = await r.json();
    render(_data);
  } catch(e){ console.error(e); }
}

function render(d){
  document.getElementById('loading').style.display='none';
  document.getElementById('grid').style.display='';

  /* stats bar */
  const gs=d.globalStats;
  let totalDirs = 0;
  (d.layerBreakdowns||[]).forEach(lb=>{ totalDirs += lb.siblingCount; });
  document.getElementById('statsBar').innerHTML=
    'Total dirs: <span>'+totalDirs+'</span> | '+
    'Files scanned: <span>'+(gs?formatBytes(gs.totalBytesScanned):'0')+'</span> | '+
    'Duration: <span>'+(gs?(gs.durationMs<1000?gs.durationMs+'ms':(gs.durationMs/1000).toFixed(1)+'s'):0)+'</span> | '+
    'System Index: <span>'+((gs&&gs.systemHungerIndex)||0)+'/100</span>';

  /* tree sidebar */
  let html=''; const parentMap={};
  (d.layerBreakdowns||[]).forEach(lb=>{
    lb.siblings.forEach(s=>{
      if(!parentMap[lb.parentPath]) parentMap[lb.parentPath]=[];
      parentMap[lb.parentPath].push({name:s.name, path:'lb.parentPath'+s.name, size:s.sizeStr});
    });
  });
  for(const [pp,siblings] of Object.entries(parentMap)){
    html+='<div style="margin:4px 0;"><b>'+pp.split('/').pop()+'</b></div>';
    siblings.forEach(s=>{
      html+='<div class="node" onclick="selectDir(\''+JSON.stringify(escapeAttr(pp+'/'+s.name)).replace(/'/g,"\\'")+'\')">';
      html+='<span style="color:var(--accent)">📁</span> <span>'+s.name+'</span> <span style="margin-left:auto;color:var(--muted)">'+s.sizeStr+'</span></div>';
    });
  }
  document.getElementById('tree').innerHTML=html;

  /* Panel A: Hunger bars as mini bar chart */
  renderPanelA(d);

  /* Panel B: Fill rates */
  renderPanelB(d);

  /* Panel C: Selected dir detail (default first) */
  if(d.layerBreakdowns?.[0]?.siblings?.[0]){
    renderPanelC(d.layerBreakdowns[0].siblings[0]);
  } else { document.getElementById('panelC').innerHTML='<div style="padding:20px;color:var(--muted)">No data</div>'; }

  /* Panel D: Summary table */
  let t='<table class="summary"><thead><tr><th>#</th><th>Dir</th><th>Size</th><th>Hunger</th><th>Rate (MB/d)</th></tr></thead><tbody>';
  d.primaryRankings.forEach((r,i)=>{
    t+='<tr><td>'+r.emoji+'</td><td>'+r.path+'</td><td>'+r.size+'</td><td style="color:'+hungerColor(r.hungerScore)+'">'+r.hungerScore+'</td><td>'+r.fillRate+'</td></tr>';
  });
  t+='</tbody></table>'; document.getElementById('panelD').innerHTML=t;
}

function renderPanelA(d){
  const entries = [];
  d.layerBreakdowns.forEach(lb=>{ lb.siblings.slice(0,15).forEach(s=>{entries.push({name:lb.parentPath.split('/').pop()+'/'+s.name,score:s.hungerScore})}); });
  const ctx = document.getElementById('panelA').getContext? document.createElement('canvas'):null;

  /* Simple bar rendering instead of chart.js for zero-dependency robustness */
  let html='';
  entries.slice(0,20).forEach(e=>{
    const c=hungerColor(e.score);
    html+='<div class="bar-row"><span class="bar-label">'+escapeHtml(e.name)+'</span><span class="bar-track"><span class="bar-fill" style="width:'+e.score+'%;background:'+c+'"></span></span><span class="bar-val">'+e.score+'</span></div>';
  });
  document.getElementById('panelA').innerHTML=html;
}

function renderPanelB(d){
  let html='';
  d.primaryRankings.slice(0,15).forEach(r=>{
    const val = r.fillRate?parseFloat(r.fillRate)||0:0;
    const w2 = Math.min(val*10,100);
    html+='<div class="bar-row"><span class="bar-label">'+r.path.split('/').pop()+'</span><span class="bar-track"><span class="bar-fill" style="width:'+w2+'%;background:#89b4fa"></span></span><span class="bar-val">'+r.fillRate+'</span></div>';
  });
  document.getElementById('panelB').innerHTML=html||'No fill rate data';
}

function renderPanelC(item){
  const c={};
  try{c=JSON.parse(localStorage.getItem('hungerDir')||'{}')}catch{}
  const dir = item; /* simplified — in real impl pass full DirSummary */
  document.getElementById('panelC').innerHTML='';// skip complex detail for now
}

function hungerColor(s){ return s>75?'var(--red)':s>50?'var(--orange)':s>25?'var(--yellow)':'var(--green)'; }
function formatBytes(b){const u=['B','KB','MB','GB','TB'];let i=0,v=b||1;while(v>=1024&&i<u.length-1){v/=1024;i++}return v.toFixed(1)+' '+u[i];}
function escapeHtml(s){try{return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}catch{return''}}function escapeAttr(s){try{return s.replace(/'/g,"&#39;")}catch{return s}}

/* Load initial data */
fetch('/api/data').then(r=>r.json()).then(d=>{_data=d;render(d);});
</script>
</body>
</html>`;
}

/* ═══════════════ main ═══════════════ */

export function run(): void {
  const cliCfg = parseArgs();                                        // ── CLI mode or web?
  const scanCfg: ScannerConfig = { root: cliCfg.entry, maxDepth: cliCfg.depth, entryCountLimit: 10_000_000 };

  if (cliCfg.mode === 'cli') {
    /* — run → format → print — */
    console.log('🍽️  Scanning %s (depth %d)...\n', scanCfg.root, cliCfg.depth);
    const scan = runScan(scanCfg);                                    // summaries + global stats
    renderCLI(scan.data, scan.global, cliCfg.topN);                   // formatted table to stdout
  } else {
    /* — web: scan then serve — */

    /* do an initial scan for the /api/data route */
    const initial = runScan(scanCfg);
    let cachedData = { data: initial.data, global: initial.global };

    const server = serve({
      port: cliCfg.port,
      async fetch(req) {
        const url = new URL(req.url);

        /* SPA dashboard */
        if (url.pathname === '/') return new Response(renderDashboardHTML(), { headers: { 'Content-Type': 'text/html' } });

        /* current scan results */
        if (url.pathname === '/api/data' && req.method === 'GET') return new Response(JSON.stringify(cachedData), { headers: { 'Content-Type': 'application/json' } });

        /* restart with new entry point */
        if (req.method === 'POST' && url.pathname === '/api/restart') { try{ const body = await req.json() as any; const ep = body?.entryPath ? body.entryPath.replace(/^~/, homedir()) : scanCfg.root; let resolved: string; try{ resolved = realpathSync(ep); } catch { return new Response(JSON.stringify({error:'invalid entry path'}),{status:400,headers:{'Content-Type':'application/json'}}); } if(!resolved) return new Response(JSON.stringify({error:'path unreachable'}),{status:400}); const fresh = runScan({root:resolved,maxDepth:body?.maxDepth??5,entryCountLimit:10_000_000}); cachedData={data:fresh.data,global:fresh.global}; return new Response(JSON.stringify(cachedData),{headers:{'Content-Type':'application/json'}}); } catch(e){ return new Response(JSON.stringify({error:String(e)}),{status:500,headers:{'Content-Type':'application/json'}}); } }

        return new Response('Not Found',{status:404});
      },
    });

    console.log(`🌐  Hunger Meter Web UI — http://localhost:${server.port}`);
  }
}

/* kick off */
run();

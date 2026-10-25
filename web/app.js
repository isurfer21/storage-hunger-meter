/* ── client-side Hunger Meter dashboard logic ── */

let _data = null;

async function reScan() {
  const entry = document.getElementById('entry').value || '';
  const btn = document.getElementById('btn-scan');
  if (!btn) return;                        // page still loading
  btn.disabled = true;
  btn.textContent = 'Scanning…';
  setLoading(true);

  try {
    const r = await fetch('/api/restart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entryPath: entry })
    });
    if (!r.ok) throw new Error(await r.text());
    _data = await r.json();

    /* show which path was scanned */
    const entrySpan = document.getElementById('scan-path');
    if (_data.entryPath) {
      entrySpan.textContent = _data.entryPath;
      document.getElementById('entry').value = _data.entryPath;
    } else if (entry) {
      entrySpan.textContent = entry;
    }

    /* scan-path already set above from _data.entryPath */

    render(_data);
  } catch(e) {
    console.error('Scan failed:', e);
    document.getElementById('loading').innerHTML = '<span style="color:var(--red)">Error: ' + escapeHtml(e.message) + '</span>';
  } finally {
    btn.disabled = false;
    btn.textContent = '▶ Scan';
    setLoading(false);
  }
}

/* ── rendering & helpers ── */

function render(d) {
  document.getElementById('loading').style.display='none';
  document.getElementById('grid').style.display='normal grid';

  const gs = d.globalStats || {};
  const layers = d.layerBreakdowns || [];

  /* stats bar */
  let totalDirs = 0;
  layers.forEach(lb => { totalDirs += lb.siblingCount; });
  document.getElementById('statsBar').innerHTML =
    'Total dirs: <span>' + totalDirs + '</span> | ' +
    'Files scanned: <span>' + formatBytes(gs.totalBytesScanned || 0) + '</span> | ' +
    'Duration: <span>' + renderDuration(gs.durationMs || 0) + '</span> | ' +
    'System Index: <span>' + (gs.systemHungerIndex || 0) + '/100</span> | ' +
    'Entry path: <span>' + escapeHtml(d.entryPath || '') + '</span>';

  /* sidebar — flat ranking table (like CLI) */
  const rankings = d.primaryRankings || [];
  let treeHtml = '<table class="summary"><thead><tr>' +
    '<th>#</th><th>Dir</th><th>Size</th><th>Rate</th><th>Hunger</th><th>Capt.</th></tr></thead><tbody>';
  rankings.forEach(r => {
    treeHtml += '<tr class="node" onclick="selectByPath(\'' + safeAttr(r.path) + '\')" ' +
      'title="' + escapeHtml(r.path) + '">' +
      '<td>' + r.emoji + '</td>' +
      '<td style="max-width:200px;overflow:hidden;text-overflow:ellipsis" title="'+escapeHtml(r.path)+'">'+escapeHtml(r.path)+'</td>' +
      '<td>' + r.size + '</td>' +
      '<td>' + r.fillRate + '</td>' +
      '<td style="color:' + hungerColor(r.hungerScore) + '">' + r.hungerScore.toFixed(1) + '</td>' +
      '<td>' + (r.capturedPct != null ? r.capturedPct + '%' : '-') + '</td></tr>';
  });
  treeHtml += '</tbody></table>';
  document.getElementById('tree').innerHTML = treeHtml;

  /* Panel A + B */
  renderPanelA(d);
  renderPanelB(d);

  /* Panel C: skip default — we have no DirSummary payload (always null). Displays on directory click instead. */
  document.getElementById('panelC').innerHTML = 'Click a directory in the sidebar';

  /* Panel D: summary table with all extra columns */
  let t = '<table class="summary"><thead><tr>' +
    '<th>#</th><th>Dir</th><th>Size</th><th>Hunger</th><th>Rate (MB/d)</th>' +
    '<th>Fill Rate</th><th>Trend</th><th>Birth</th><th>Sib Imb</th><th>Icel Pen</th><th>Inode R</th></tr></thead><tbody>';
  (d.primaryRankings || []).forEach(r => {
    t += '<tr>' +
      '<td>'+r.emoji+'</td>' +
      '<td style="max-width:200px;overflow:hidden;text-overflow:ellipsis" title="'+escapeHtml(r.path)+'">'+escapeHtml(r.path)+'</td>' +
      '<td>'+r.size+'</td>' +
      '<td style="color:'+hungerColor(r.hungerScore)+'">'+r.hungerScore.toFixed(1)+'</td>' +
      '<td>'+r.fillRate+'</td>' +
      '<td>('+(r.contributions?.fillRateContribution??'-')+')</td>' +
      '<td>('+(r.contributions?.trendSlopeContribution??'-')+')</td>' +
      '<td>('+(r.contributions?.birthGateContribution??'-')+')</td>' +
      '<td>'+ (r.contributions?.siblingImbalanceContribution??'-') +'</td>' +
      '<td>('+(r.contributions?.icebergPenaltyContribution??'-')+')</td>' +
      '<td>'+ (r.contributions?.inodeRiskContribution??'-') +'</td></tr>';
  });
  t += '</tbody></table>';
  document.getElementById('panelD').innerHTML = t;
}

function renderPanelA(d) {
  const entries = [];
  (d.layerBreakdowns || []).forEach(lb => {
    lb.siblings.forEach(s => { entries.push({ name: lb.parentPath.split('/').pop() + '/' + s.name, score: s.hungerScore }); });
  });
  let html = '';
  (entries.slice(0, 25) || []).forEach(e => {
    const c = hungerColor(e.score);
    html += '<div class="bar-row">' +
      '<span class="bar-label">' + escapeHtml(e.name) + '</span>' +
      '<span class="bar-track"><span class="bar-fill" style="width:' + e.score + '%;background:' + c + '"></span></span>' +
      '<span class="bar-val">' + e.score.toFixed(1) + '</span></div>';
  });
  document.getElementById('panelA').innerHTML = html || 'No data';
}

function renderPanelB(d) {
  let html = '';
  (d.primaryRankings || []).slice(0, 25).forEach(r => {
    const val = r.fillRate ? parseFloat(r.fillRate) || 0 : 0;
    const w2 = Math.min(val * 10, 100);
    html += '<div class="bar-row">' +
      '<span class="bar-label">' + escapeHtml(r.path.split('/').pop()) + '</span>' +
      '<span class="bar-track"><span class="bar-fill" style="width:' + w2 + '%;background:#89b4fa"></span></span>' +
      '<span class="bar-val">' + r.fillRate + '</span></div>';
  });
  document.getElementById('panelB').innerHTML = html || 'No data';
}

function renderPanelC(dir) {
  if (!dir) return;
  const cells = [
    ['Total Size', dir.totalSizeBytes != null ? formatBytes(dir.totalSizeBytes) : '—'],
    ['File Count', dir.fileCount?.toString() ?? '—'],
    ['Dir Count', dir.dirCount?.toString() ?? '—'],
    ['Avg Dir Size', dir.totalSizeBytes && dir.fileCount > 0 ? formatBytes(dir.totalSizeBytes / dir.fileCount) : '—'],
    ['Inode Risk', (dir.inodeRisk ?? 0).toFixed(1)],
    ['Mtime MR/M/d', (dir.mtimeFillRateMBd ?? 0).toFixed(2) + ' MB/d'],
    ['Birth Gate', (dir.birthGateRateMBd ?? 0).toFixed(2) + ' MB/d'],
    ['Sib Balance', dir.siblingFraction != null ? dir.siblingFraction.toFixed(3) : '—'],
    ['Deph Conc.', dir.depthConcentration != null ? dir.depthConcentration.toFixed(3) : '—'],
  ];
  let html = '<div class="data-grid" style="display:grid">';
  cells.forEach(([label, value]) => {
    html += '<div class="data-cell">' +
      '<div class="label">' + escapeHtml(label) + '</div>' +
      '<div class="value">' + escapeHtml(String(value)) + '</div></div>';
  });
  html += '</div>';
  document.getElementById('panelC').innerHTML = '';
  document.getElementById('detailGrid').innerHTML = html;
  document.getElementById('detailGrid').style.display = 'grid';
}

function selectByPath(dirPath) {
  /* highlight active row */
  document.querySelectorAll('#tree .node').forEach(n => n.classList.remove('active'));
  event.currentTarget.classList.add('active');

  if (_data?.primaryRankings) {
    const r = _data.primaryRankings.find(p => p.path === dirPath);
    if (r) renderPanelC({
      name: dirPath.split('/').pop(), totalSizeBytes: null, fileCount: '-', dirCount: '-',
      inodeRisk: 0, mtimeFillRateMBd: parseFloat(r.fillRate) || 0, birthGateRateMBd: 0,
      siblingFraction: null, depthConcentration: null,
    });
  }
}

function avgBytes(dir) {
  return dir.fileCount > 0 ? dir.totalSizeBytes / dir.fileCount : 0;
}

function hungerColor(s) { return s > 75 ? 'var(--red)' : s > 50 ? 'var(--orange)' : s > 25 ? 'var(--yellow)' : 'var(--green)'; }
function formatBytes(b) {
  const u = ['B','KB','MB','GB','TB']; let i=0, v=Math.max(Math.abs(b),1);
  while (v >= 1024 && i < u.length-1) { v /= 1024; i++; } return v.toFixed(1)+' '+u[i];
}
function renderDuration(ms) {
  if (ms < 1000) return ms + 'ms';
  const s = (ms / 1000).toFixed(1);
  return Number(s) >= 60 ? Math.floor(Number(s)/60)+'m '+Math.floor(Number(s)%60)+'s' : s+'s';
}
function escapeHtml(s) { try { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); } catch { return ''; } }
function escapeAttr(s)  { try { return String(s).replace(/"/g, '\\"'); } catch { return s; } }
function safeAttr(s)    { try { return String(s).replace(/'/g, "\\'").replace(/"/g, '\\"'); } catch { return s; } }

/* ── loading state ── */
let _scrollPos = 0;
function setLoading(on) {
  const el = document.getElementById('loading');
  if (on) {
    _scrollPos = window.scrollY;
    el.style.display = 'flex';
    el.innerHTML = '<div style="text-align:center">' +
      '<div style="font-size:24px;margin-bottom:10px">@</div>' +
      '<span>Scanning… please wait</span></div>';
  } else {
    el.style.display = 'none';
    window.scrollTo(0, _scrollPos);
  }
}

/* ── initial load ── */
fetch('/api/data').then(r => r.json()).then(d => { _data = d; render(_data); });

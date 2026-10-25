/* ── client-side Hunger Meter dashboard logic ── */

let _data = null;

async function reScan() {
  const entry = document.getElementById('entry').value || '';
  const btn = document.getElementById('btn-scan');
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

    /* also show initial scan's entry path */
    if (!_data.entryPath && _data.data?.length) {
      const root = _data.data.find(d => d.parentPath === '/' || d.path.endsWith('/'));
      if (root) document.getElementById('scan-path').textContent = root.path;
    }

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

  /* tree sidebar */
  const parentMap = {};
  layers.forEach(lb => {
    lb.siblings.forEach(s => {
      if (!parentMap[lb.parentPath]) parentMap[lb.parentPath] = [];
      const safeKey = escapeAttr(lb.parentPath);
      parentMap[lb.parentPath].push({ name: s.name, path: safeKey + '/' + escapeAttr(s.name), size: s.sizeStr });
    });
  });
  let html = '';
  for (const pp of Object.keys(parentMap)) {
    html += '<div>' +
      '<b>' + escapeHtml(pp.split('/').filter(Boolean).pop()) + '</b>';
    parentMap[pp].forEach(s => {
      html += '<div class="node" onclick="selectDir(\'' + s.path + '\')" data-dir="' + safeAttr(pp + '/' + s.name) + '">' +
        '📁&nbsp;<span>' + escapeHtml(s.name) + '</span>' +
        '<span style="margin-left:auto;color:var(--muted)">' + s.sizeStr + '</span></div>';
    });
    html += '</div>';
  }
  document.getElementById('tree').innerHTML = html;

  /* Panel A + B */
  renderPanelA(d);
  renderPanelB(d);

  /* Panel C: default to first sibling for inspection */
  const firstLayer = layers[0];
  if (firstLayer?.siblings?.[0]) {
    /* build a DirSummary-like object from the layer data */
    renderPanelC({ name: firstLayer.siblings[0].name, totalSizeBytes: parseSize(firstLayer.parentPath) }); // placeholder
  }

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
  if (!dir || !dir.totalSizeBytes) return;
  const cells = [
    ['Total Size', formatBytes(dir.totalSizeBytes)],
    ['File Count', dir.fileCount?.toString() ?? '-'],
    ['Dir Count', dir.dirCount?.toString() ?? '-'],
    ['Avg Dir Size', formatBytes(avgBytes(dir))],
    ['Inode Risk', (dir.inodeRisk ?? 0).toFixed(1)],
    ['Mtime MR/M/d', (dir.mtimeFillRateMBd??0).toFixed(2) + ' MB/d'],
    ['Birth Gate', (dir.birthGateRateMBd??0).toFixed(2) + ' MB/d'],
    ['Sib Balance', dir.siblingFraction != null ? dir.siblingFraction.toFixed(3) : '-'],
    ['Deph Conc.', dir.depthConcentration != null ? dir.depthConcentration.toFixed(3) : '-'],
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

function selectDir(dirPath) {
  /* highlight active */
  document.querySelectorAll('#tree .node').forEach(n => n.classList.remove('active'));
  event.currentTarget.classList.add('active');

  /* find the matching DirSummary in cached data and display its detail */
  if (_data?.layerBreakdowns) {
    const found = _data.layerBreakdowns.flatMap(lb => lb.siblings).find(s => dirPath.split('/').pop() === s.name);
    if (found) {
      /* we need the real DirSummary object — build from layerBreakdown + data */
      for (const lb of _data.layerBreakdowns) {
        const dir = _data.data.find(d => d.name === found.name && d.parentPath === lb.parentPath);
        if (dir) { renderPanelC(dir); return; }
      }
    }
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

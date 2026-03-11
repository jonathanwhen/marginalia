// ── HTML escaping ────────────────────────────────────────────────
function esc(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ── Markdown + math rendering ───────────────────────────────────
function renderMarkdownWithMath(text) {
  if (!text) return '';
  if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') return esc(text);

  let html = marked.parse(text);
  html = DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });

  if (typeof katex !== 'undefined') {
    html = html.replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex) => {
      try { return katex.renderToString(tex.trim(), { displayMode: true, throwOnError: false }); }
      catch { return `<code>${esc(tex)}</code>`; }
    });
    html = html.replace(/(?<!\$)\$(?!\$)((?:[^$\\]|\\.)+?)\$/g, (_m, tex) => {
      try { return katex.renderToString(tex.trim(), { displayMode: false, throwOnError: false }); }
      catch { return `<code>${esc(tex)}</code>`; }
    });
  }
  return html;
}

// ── LaTeX rendering helpers ─────────────────────────────────────
// Render a raw LaTeX string (from h.latex) as formatted HTML via KaTeX.
function renderLatex(tex) {
  if (!tex || typeof katex === 'undefined') return `<code>${esc(tex)}</code>`;
  try {
    return katex.renderToString(tex, { throwOnError: false, displayMode: false });
  } catch {
    return `<code>${esc(tex)}</code>`;
  }
}

// Process text that may contain inline $...$ or display $$...$$ math delimiters.
// Returns an HTML string with math segments rendered via KaTeX.
function renderMathInText(text) {
  if (!text || typeof katex === 'undefined') return esc(text);
  // Escape the text first, then replace math delimiters in the escaped output.
  // We work on the raw text to find delimiters, then build output piecewise.
  let result = '';
  let i = 0;
  while (i < text.length) {
    // Display math: $$...$$
    if (text[i] === '$' && text[i + 1] === '$') {
      const end = text.indexOf('$$', i + 2);
      if (end !== -1) {
        const tex = text.slice(i + 2, end);
        try {
          result += katex.renderToString(tex, { throwOnError: false, displayMode: true });
        } catch {
          result += '$$' + esc(tex) + '$$';
        }
        i = end + 2;
        continue;
      }
    }
    // Inline math: $...$  (not preceded by another $, content must not contain newlines)
    if (text[i] === '$' && (i === 0 || text[i - 1] !== '$')) {
      const end = text.indexOf('$', i + 1);
      if (end !== -1 && !text.slice(i + 1, end).includes('\n')) {
        const tex = text.slice(i + 1, end);
        try {
          result += katex.renderToString(tex, { throwOnError: false, displayMode: false });
        } catch {
          result += '$' + esc(tex) + '$';
        }
        i = end + 1;
        continue;
      }
    }
    result += esc(text[i]);
    i++;
  }
  return result;
}

// ── Tag color palette ────────────────────────────────────────────
const TAG_COLORS = {
  'AI/ML Research':     '#e8a87c',
  'Healthcare/Bio':     '#6fcf97',
  'Philosophy':         '#b87ce8',
  'Economics/Finance':  '#e8d47c',
  'Research Craft':     '#7cc8e8',
  'General Learning':   '#7ca8e8',
  'To Revisit':         '#e87c7c'
};

function getTagColor(tag) {
  return TAG_COLORS[tag] || '#888';
}

function getRowAccent(tags) {
  if (!tags?.length) return '#252525';
  return TAG_COLORS[tags[0]] || '#252525';
}

// ── State ────────────────────────────────────────────────────────
let allReadings = [];
let sortCol = 'date';
let sortAsc = false;
let activeTag = null;

const COLUMNS = [
  { key: 'title',  label: 'Title',  cls: 'col-title' },
  { key: 'author', label: 'Author', cls: 'col-author' },
  { key: 'tags',   label: 'Tags',   cls: 'col-tags' },
  { key: 'pages',  label: 'Pages',  cls: 'col-pages' },
  { key: 'hl',     label: 'HL',     cls: 'col-hl' },
  { key: 'date',   label: 'Date',   cls: 'col-date' },
  { key: 'actions',label: '',       cls: 'col-actions' },
];

// ── Load readings ────────────────────────────────────────────────
async function loadReadings() {
  const { ocReadings = {} } = await chrome.storage.local.get('ocReadings');
  const pageKeys = Object.keys(ocReadings);
  const hlData = pageKeys.length ? await chrome.storage.local.get(pageKeys) : {};

  allReadings = pageKeys.map(pageKey => {
    const r = ocReadings[pageKey];
    const highlights = hlData[pageKey];
    const hlCount = Array.isArray(highlights) ? highlights.length : 0;
    return { pageKey, ...r, hlCount };
  });

  // Load reading positions for progress bars
  if (allReadings.length) {
    const posKeys = allReadings.map(r => `pos:${r.pageKey}`);
    const posData = await chrome.storage.local.get(posKeys);
    for (const r of allReadings) {
      const pos = posData[`pos:${r.pageKey}`];
      if (pos && r.estPages) {
        r.progress = Math.min(pos.scrollFraction || 0, 1);
      }
    }
  }

  document.getElementById('total-count').textContent =
    `${allReadings.length} reading${allReadings.length !== 1 ? 's' : ''}`;

  const dailyData = computeDailyData(allReadings);
  renderStats(computeStats(allReadings), dailyData);
  renderHeatmap(allReadings);
  renderTagFilters(allReadings);
  renderTable(getFilteredReadings());
}

// ── Stats ────────────────────────────────────────────────────────
function computeStats(readings) {
  let totalPages = 0;
  const totalReadings = readings.length;
  const streak = computeStreak(readings);

  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  weekAgo.setHours(0, 0, 0, 0);
  const weekAgoStr = localDateStr(weekAgo);

  const twoWeeksAgo = new Date();
  twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
  twoWeeksAgo.setHours(0, 0, 0, 0);
  const twoWeeksAgoStr = localDateStr(twoWeeksAgo);

  let weekPages = 0;
  let lastWeekPages = 0;

  for (const r of readings) {
    if (r.readingLog && Object.keys(r.readingLog).length > 0) {
      for (const [date, pages] of Object.entries(r.readingLog)) {
        totalPages += pages;
        if (date >= weekAgoStr) weekPages += pages;
        else if (date >= twoWeeksAgoStr) lastWeekPages += pages;
      }
    } else {
      totalPages += r.estPages || 0;
      if (r.createdAt && new Date(r.createdAt) >= weekAgo) weekPages += r.estPages || 0;
      else if (r.createdAt && new Date(r.createdAt) >= twoWeeksAgo) lastWeekPages += r.estPages || 0;
    }
  }

  const weekTrend = lastWeekPages > 0
    ? Math.round(((weekPages - lastWeekPages) / lastWeekPages) * 100)
    : (weekPages > 0 ? 100 : 0);

  return { totalPages, totalReadings, streak, weekPages, weekTrend };
}

// ── Daily data for sparklines ─────────────────────────────────────
function computeDailyData(readings) {
  const days = 7;
  const dailyPages = new Array(days).fill(0);
  const dailyReadings = new Array(days).fill(0);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (const r of readings) {
    if (r.readingLog && Object.keys(r.readingLog).length > 0) {
      // Distribute pages from readingLog across their respective days
      for (const [dateStr, pages] of Object.entries(r.readingLog)) {
        const d = new Date(dateStr + 'T00:00:00');
        const daysAgo = Math.floor((today - d) / (1000 * 60 * 60 * 24));
        if (daysAgo >= 0 && daysAgo < days) {
          const index = days - 1 - daysAgo;
          dailyPages[index] += pages;
          dailyReadings[index] += 1;
        }
      }
    } else {
      if (!r.createdAt) continue;
      const d = new Date(r.createdAt);
      d.setHours(0, 0, 0, 0);
      const daysAgo = Math.floor((today - d) / (1000 * 60 * 60 * 24));
      if (daysAgo >= 0 && daysAgo < days) {
        const index = days - 1 - daysAgo;
        dailyPages[index] += r.estPages || 0;
        dailyReadings[index] += 1;
      }
    }
  }

  return { dailyPages, dailyReadings };
}

// ── Sparkline SVG generation ──────────────────────────────────────
function sparklineSvg(data) {
  if (!data.length || data.every(v => v === 0)) return '';
  const max = Math.max(...data, 1);
  const w = 80, h = 28;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - (v / max) * (h - 4) - 2;
    return `${x},${y}`;
  });
  const line = pts.join(' ');
  const area = `0,${h} ${line} ${w},${h}`;
  return `<svg class="sparkline" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <polygon points="${area}" fill="rgba(232,168,124,0.06)" />
    <polyline points="${line}" fill="none" stroke="rgba(232,168,124,0.35)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
  </svg>`;
}

function computeStreak(readings) {
  const days = new Set();
  for (const r of readings) {
    if (r.readingLog) {
      for (const date of Object.keys(r.readingLog)) days.add(date);
    }
    if (r.createdAt) days.add(localDateStr(new Date(r.createdAt)));
  }

  let streak = 0;
  const d = new Date();
  d.setHours(0, 0, 0, 0);

  // If no reading today, check from yesterday
  if (!days.has(localDateStr(d))) {
    d.setDate(d.getDate() - 1);
    if (!days.has(localDateStr(d))) return 0;
  }

  while (days.has(localDateStr(d))) {
    streak++;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

function renderStats(stats, dailyData) {
  const grid = document.getElementById('stats-grid');

  // Week-over-week trend indicator
  let trendHtml = '';
  if (stats.weekPages > 0 || stats.weekTrend !== 0) {
    const arrow = stats.weekTrend > 0 ? '↑' : stats.weekTrend < 0 ? '↓' : '→';
    const cls = stats.weekTrend > 0 ? 'up' : stats.weekTrend < 0 ? 'down' : 'flat';
    trendHtml = `<span class="stat-trend ${cls}">${arrow} ${Math.abs(stats.weekTrend)}%</span>`;
  }

  const items = [
    { value: stats.totalPages, label: 'Pages Read', spark: sparklineSvg(dailyData.dailyPages) },
    { value: stats.totalReadings, label: 'Readings', spark: sparklineSvg(dailyData.dailyReadings) },
    { value: stats.streak, label: 'Day Streak' },
    { value: stats.weekPages, label: 'Pages This Week', extra: trendHtml },
  ];

  grid.innerHTML = items.map(item => `
    <div class="stat-card animate-in">
      <div class="stat-value" data-target="${item.value}">0</div>
      <div class="stat-label">${item.label}${item.extra || ''}</div>
      ${item.spark || ''}
    </div>
  `).join('');

  grid.querySelectorAll('.stat-value').forEach(el => {
    animateValue(el, parseInt(el.dataset.target, 10));
  });
}

function animateValue(el, target, duration = 800) {
  if (target === 0) { el.textContent = '0'; return; }
  const startTime = performance.now();
  function update(now) {
    const progress = Math.min((now - startTime) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = Math.round(target * eased).toLocaleString();
    if (progress < 1) requestAnimationFrame(update);
  }
  requestAnimationFrame(update);
}

// ── Heatmap ──────────────────────────────────────────────────────
function renderHeatmap(readings) {
  const WEEKS = 26;
  const CELL_SIZE = 12;
  const GAP = 3;

  // Build day -> pages map using local dates
  const dayPages = {};
  for (const r of readings) {
    if (r.readingLog && Object.keys(r.readingLog).length > 0) {
      for (const [date, pages] of Object.entries(r.readingLog)) {
        dayPages[date] = (dayPages[date] || 0) + pages;
      }
    } else {
      if (!r.createdAt) continue;
      const key = localDateStr(new Date(r.createdAt));
      dayPages[key] = (dayPages[key] || 0) + (r.estPages || 0);
    }
  }

  // Align start to Monday, WEEKS weeks ago
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayDow = (today.getDay() + 6) % 7; // 0=Mon, 6=Sun
  const start = new Date(today);
  start.setDate(start.getDate() - (WEEKS * 7) - todayDow);

  const cells = [];
  const current = new Date(start);
  while (current <= today) {
    const key = localDateStr(current);
    cells.push({
      date: new Date(current),
      dateStr: key,
      pages: dayPages[key] || 0,
      dow: (current.getDay() + 6) % 7
    });
    current.setDate(current.getDate() + 1);
  }

  // Day labels — all 7 days as single letters
  const dayLabels = document.getElementById('hm-day-labels');
  dayLabels.innerHTML = ['M', 'T', 'W', 'T', 'F', 'S', 'S']
    .map(d => `<div class="hm-day-label">${d}</div>`).join('');

  // Month labels — collect boundaries then filter overlaps
  const monthsEl = document.getElementById('hm-months');
  const boundaries = [];
  let lastMonth = -1;
  let colIndex = 0;
  for (let i = 0; i < cells.length; i++) {
    if (cells[i].dow === 0) {
      const month = cells[i].date.getMonth();
      if (month !== lastMonth) {
        boundaries.push({
          label: cells[i].date.toLocaleString('default', { month: 'short' }),
          col: colIndex
        });
        lastMonth = month;
      }
      colIndex++;
    }
  }
  // Drop labels that are too close — when two overlap, skip the earlier (partial) month
  const MIN_COL_GAP = 4;
  const kept = [];
  for (let i = 0; i < boundaries.length; i++) {
    if (kept.length === 0) {
      // If first month only has a sliver before the next, skip it
      if (i + 1 < boundaries.length && boundaries[i + 1].col - boundaries[i].col < MIN_COL_GAP) {
        continue;
      }
      kept.push(boundaries[i]);
    } else if (boundaries[i].col - kept[kept.length - 1].col >= MIN_COL_GAP) {
      kept.push(boundaries[i]);
    }
  }
  monthsEl.innerHTML = kept.map(b => {
    const x = b.col * (CELL_SIZE + GAP);
    return `<span class="hm-month-label" style="left:${x}px">${b.label}</span>`;
  }).join('');

  // Grid cells
  const gridEl = document.getElementById('hm-grid');
  gridEl.innerHTML = cells.map(c => {
    const level = heatmapLevel(c.pages);
    const dateFmt = c.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const tip = c.pages > 0
      ? `${dateFmt}: ${c.pages} pages`
      : `${dateFmt}: No reading`;
    return `<div class="hm-cell hm-${level}" data-tip="${esc(tip)}"></div>`;
  }).join('');
}

function heatmapLevel(pages) {
  if (pages === 0) return 0;
  if (pages <= 10) return 1;
  if (pages <= 25) return 2;
  if (pages <= 50) return 3;
  return 4;
}

// ── Tag filters ──────────────────────────────────────────────────
function renderTagFilters(readings) {
  const tagCounts = {};
  for (const r of readings) {
    for (const tag of (r.tags || [])) {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }
  }

  const tags = Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([tag]) => tag);

  const container = document.getElementById('tag-filters');
  if (!tags.length) { container.innerHTML = ''; return; }

  container.innerHTML = tags.map(tag => {
    const color = getTagColor(tag);
    const isActive = activeTag === tag;
    const activeStyle = isActive
      ? `border-color:${color}; color:${color}; background:color-mix(in srgb, ${color} 10%, transparent);`
      : '';
    return `<button class="tag-pill${isActive ? ' active' : ''}" data-tag="${esc(tag)}" style="${activeStyle}">${esc(tag)}</button>`;
  }).join('');

  container.querySelectorAll('.tag-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      activeTag = activeTag === btn.dataset.tag ? null : btn.dataset.tag;
      renderTagFilters(allReadings);
      renderTable(getFilteredReadings());
    });
  });
}

// ── Table ────────────────────────────────────────────────────────
function renderTable(readings) {
  const wrap = document.getElementById('table-wrap');

  if (!readings.length) {
    const hasFilter = activeTag || document.getElementById('search').value.trim();
    wrap.innerHTML = hasFilter
      ? `<div class="empty-state"><p>No readings match your search</p>
         <div class="hint">Try a different search term or clear your filters.</div></div>`
      : `<div class="empty-state"><div class="empty-icon">✦</div>
         <p>No readings yet</p>
         <div class="hint">Use the popup to log your first reading.</div></div>`;
    return;
  }

  const sorted = sortReadings(readings);
  const arrow = sortAsc ? '&#9650;' : '&#9660;';

  let html = '<table><thead><tr>';
  for (const col of COLUMNS) {
    if (col.key === 'actions') {
      html += `<th class="${col.cls}"></th>`;
      continue;
    }
    const isActive = sortCol === col.key;
    html += `<th class="${col.cls}" data-col="${col.key}">${esc(col.label)}`;
    if (isActive) html += `<span class="sort-arrow">${arrow}</span>`;
    html += '</th>';
  }
  html += '</tr></thead><tbody>';

  for (const r of sorted) {
    const color = getRowAccent(r.tags);
    const tagsHtml = (r.tags || []).map(t => {
      const tc = getTagColor(t);
      return `<span class="tag" style="border-color:${tc}; color:${tc}; background:color-mix(in srgb, ${tc} 10%, transparent);">${esc(t)}</span>`;
    }).join('');
    const hlBadge = r.hlCount > 0
      ? `<span class="hl-badge has-hl">${r.hlCount}</span>`
      : `<span class="hl-badge no-hl">0</span>`;

    const isLibrary = r.pageKey.startsWith('library:');
    const titlePrefix = isLibrary ? '📄 ' : '';

    const progressHtml = r.progress != null
      ? `<div class="row-progress"><div class="row-progress-fill" style="width:${Math.round(r.progress * 100)}%"></div></div>`
      : '';

    html += `<tr class="row" data-pk="${esc(r.pageKey)}" style="--row-accent:${color}">
      <td class="col-title" title="${esc(r.title)}"><span class="title-text">${titlePrefix}${esc(r.title || '(untitled)')}</span>${progressHtml}</td>
      <td class="col-author">${esc(r.author || '\u2014')}</td>
      <td class="col-tags">${tagsHtml || '<span style="color:var(--text-4)">\u2014</span>'}</td>
      <td class="col-pages">${r.estPages || '\u2014'}</td>
      <td class="col-hl">${hlBadge}</td>
      <td class="col-date">${esc(formatDate(r.createdAt))}</td>
      <td class="col-actions"><button class="row-delete" data-pk="${esc(r.pageKey)}" title="Delete">\u00d7</button></td>
    </tr>`;

    html += `<tr class="detail-row" data-detail-pk="${esc(r.pageKey)}">
      <td colspan="${COLUMNS.length}"><div class="detail-content">Loading...</div></td>
    </tr>`;
  }

  html += '</tbody></table>';
  wrap.innerHTML = html;

  // Sort headers
  wrap.querySelectorAll('thead th').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (sortCol === col) sortAsc = !sortAsc;
      else { sortCol = col; sortAsc = col === 'title' || col === 'author'; }
      renderTable(getFilteredReadings());
    });
  });

  // Inline delete buttons
  wrap.querySelectorAll('.row-delete').forEach(btn => {
    let confirmPending = false;
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirmPending) {
        confirmPending = true;
        btn.classList.add('confirm');
        btn.title = 'Click again to confirm';
        setTimeout(() => {
          if (confirmPending) {
            confirmPending = false;
            btn.classList.remove('confirm');
            btn.title = 'Delete';
          }
        }, 3000);
        return;
      }
      await deleteReading(btn.dataset.pk);
    });
  });

  // Row expand
  wrap.querySelectorAll('tr.row').forEach(tr => {
    tr.addEventListener('click', () => {
      const pk = tr.dataset.pk;
      const detailTr = wrap.querySelector(`tr.detail-row[data-detail-pk="${CSS.escape(pk)}"]`);
      toggleDetail(tr, detailTr, allReadings.find(r => r.pageKey === pk));
    });
  });
}

// ── Sort ─────────────────────────────────────────────────────────
function sortReadings(readings) {
  const copy = [...readings];
  const dir = sortAsc ? 1 : -1;

  copy.sort((a, b) => {
    let va, vb;
    switch (sortCol) {
      case 'title':  va = (a.title || '').toLowerCase(); vb = (b.title || '').toLowerCase(); break;
      case 'author': va = (a.author || '').toLowerCase(); vb = (b.author || '').toLowerCase(); break;
      case 'tags':   va = (a.tags || []).join(',').toLowerCase(); vb = (b.tags || []).join(',').toLowerCase(); break;
      case 'pages':  va = a.estPages || 0; vb = b.estPages || 0; break;
      case 'hl':     va = a.hlCount || 0; vb = b.hlCount || 0; break;
      case 'date':   va = a.createdAt || ''; vb = b.createdAt || ''; break;
      default:       va = ''; vb = '';
    }
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return 0;
  });

  return copy;
}

// ── Detail toggle ────────────────────────────────────────────────
async function toggleDetail(tr, detailTr, reading) {
  if (detailTr.classList.contains('open')) {
    detailTr.classList.remove('open');
    return;
  }

  document.querySelectorAll('tr.detail-row.open').forEach(r => r.classList.remove('open'));
  detailTr.classList.add('open');

  if (!reading) {
    detailTr.querySelector('.detail-content').innerHTML =
      '<span style="color:var(--text-3)">Reading not found.</span>';
    return;
  }

  const hlResult = await chrome.storage.local.get([reading.pageKey]);
  const highlights = Array.isArray(hlResult[reading.pageKey]) ? hlResult[reading.pageKey] : [];
  const container = detailTr.querySelector('.detail-content');

  // Left column: metadata + notes
  let metaHtml = `<div><h4 class="detail-section-title">Details</h4><div class="detail-meta">`;
  metaHtml += `<div class="meta-row"><span class="meta-label">Title</span><span class="meta-value">${esc(reading.title || '')}</span></div>`;
  if (reading.author) metaHtml += `<div class="meta-row"><span class="meta-label">Author</span><span class="meta-value">${esc(reading.author)}</span></div>`;
  if (reading.tags?.length) metaHtml += `<div class="meta-row"><span class="meta-label">Tags</span><span class="meta-value">${reading.tags.map(t => esc(t)).join(', ')}</span></div>`;
  if (reading.estPages) metaHtml += `<div class="meta-row"><span class="meta-label">Pages</span><span class="meta-value">${reading.estPages}</span></div>`;
  if (reading.url) metaHtml += `<div class="meta-row"><span class="meta-label">URL</span><span class="meta-value"><a href="${esc(reading.url)}" target="_blank" rel="noopener">${esc(reading.url)}</a></span></div>`;
  metaHtml += `<div class="meta-row"><span class="meta-label">Logged</span><span class="meta-value">${esc(formatDateFull(reading.createdAt))}</span></div>`;
  if (reading.updatedAt !== reading.createdAt) {
    metaHtml += `<div class="meta-row"><span class="meta-label">Updated</span><span class="meta-value">${esc(formatDateFull(reading.updatedAt))}</span></div>`;
  }
  metaHtml += '</div>';
  if (reading.conversationUrl) metaHtml += `<a class="detail-conv-link" href="${esc(reading.conversationUrl)}" target="_blank" rel="noopener">💬 Claude conversation</a>`;
  if (reading.notes) metaHtml += `<div class="detail-notes">${renderMarkdownWithMath(reading.notes)}</div>`;
  metaHtml += '</div>';

  // Right column: highlights
  let hlHtml = `<div><h4 class="detail-section-title">Highlights (${highlights.length})</h4>`;
  if (highlights.length) {
    hlHtml += '<ul class="detail-hl-list">';
    for (const h of highlights) {
      hlHtml += '<li class="detail-hl-item">';
      hlHtml += `<div class="detail-hl-quote">"${esc(h.text)}"</div>`;
      if (h.latex) hlHtml += `<div class="detail-hl-latex">${renderLatex(h.latex)}</div>`;
      if (h.comment) hlHtml += `<div class="detail-hl-comment">${renderMathInText(h.comment)}</div>`;
      hlHtml += '</li>';
    }
    hlHtml += '</ul>';
  } else {
    hlHtml += '<div class="detail-hl-empty">No highlights for this reading.</div>';
  }
  hlHtml += '</div>';

  const deleteBtnHtml = `<button class="delete-btn" data-pk="${esc(reading.pageKey)}" style="background:rgba(235,87,87,0.12);border:1px solid rgba(235,87,87,0.4);border-radius:5px;color:#eb5757;font-size:12px;padding:8px 18px;cursor:pointer;font-weight:600;">Delete Reading</button>`;
  const isLibraryItem = reading.pageKey.startsWith('library:');
  const openReaderBtnHtml = isLibraryItem
    ? `<a href="${chrome.runtime.getURL('library-reader.html?key=' + encodeURIComponent(reading.pageKey))}" target="_blank" style="background:rgba(111,207,151,0.12);border:1px solid rgba(111,207,151,0.4);border-radius:5px;color:#6fcf97;font-size:12px;padding:8px 18px;cursor:pointer;font-weight:600;text-decoration:none;display:inline-block;">Open in Reader</a>`
    : '';

  // Reading progress section (for manually tracking pages read per day)
  const log = reading.readingLog || {};
  const logEntries = Object.entries(log).sort((a, b) => b[0].localeCompare(a[0]));
  const loggedTotal = logEntries.reduce((s, [, p]) => s + p, 0);
  const todayStr = localDateStr(new Date());

  let progressHtml = `<div class="reading-progress">
    <h4 class="detail-section-title">Reading Progress</h4>`;

  if (reading.estPages) {
    const pct = Math.min(Math.round((loggedTotal / reading.estPages) * 100), 100);
    progressHtml += `<div class="rp-summary">${loggedTotal} / ${reading.estPages} pages
      <div class="rp-bar"><div class="rp-bar-fill" style="width:${pct}%"></div></div></div>`;
  } else if (loggedTotal > 0) {
    progressHtml += `<div class="rp-summary">${loggedTotal} pages logged</div>`;
  }

  progressHtml += `<div class="rp-form">
    <input type="date" class="rp-date" value="${todayStr}" />
    <input type="number" class="rp-pages" min="0" placeholder="Pages" />
    <button class="rp-log-btn">Log</button>
  </div>`;

  if (logEntries.length) {
    progressHtml += '<div class="rp-entries">';
    for (const [date, pages] of logEntries) {
      progressHtml += `<div class="rp-entry" data-date="${esc(date)}">
        <span class="rp-entry-date">${date}</span>
        <span class="rp-entry-pages">${pages} pg</span>
        <button class="rp-entry-del" data-date="${esc(date)}">&times;</button>
      </div>`;
    }
    progressHtml += '</div>';
  }

  progressHtml += '</div>';

  container.innerHTML = `<div class="detail-panel">
    <div style="display:flex;justify-content:flex-start;gap:10px;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid #1e1e1e;">${openReaderBtnHtml}${deleteBtnHtml}</div>
    ${progressHtml}
    <div class="detail-grid">${metaHtml}${hlHtml}</div>
  </div>`;

  // Delete with confirmation
  const deleteBtn = container.querySelector('.delete-btn');
  let confirmPending = false;
  deleteBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirmPending) {
      confirmPending = true;
      deleteBtn.textContent = 'Click again to confirm';
      deleteBtn.classList.add('confirm');
      setTimeout(() => {
        if (confirmPending) {
          confirmPending = false;
          deleteBtn.textContent = 'Delete Reading';
          deleteBtn.classList.remove('confirm');
        }
      }, 3000);
      return;
    }
    await deleteReading(reading.pageKey);
  });

  // Reading progress: log button
  const rpLogBtn = container.querySelector('.rp-log-btn');
  if (rpLogBtn) {
    rpLogBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const dateInput = container.querySelector('.rp-date');
      const pagesInput = container.querySelector('.rp-pages');
      const date = dateInput.value;
      const pages = parseInt(pagesInput.value, 10);
      if (!date || isNaN(pages) || pages < 0) return;
      await chrome.runtime.sendMessage({ type: 'oc-log-pages', pageKey: reading.pageKey, date, pages });
      await loadReadings();
      // Re-open detail panel
      const newTr = document.querySelector(`tr.row[data-pk="${CSS.escape(reading.pageKey)}"]`);
      const newDetailTr = document.querySelector(`tr.detail-row[data-detail-pk="${CSS.escape(reading.pageKey)}"]`);
      const updated = allReadings.find(r => r.pageKey === reading.pageKey);
      if (newTr && newDetailTr && updated) toggleDetail(newTr, newDetailTr, updated);
    });
  }

  // Reading progress: click entry to edit, delete button to remove
  container.querySelectorAll('.rp-entry').forEach(entry => {
    entry.addEventListener('click', (e) => {
      if (e.target.classList.contains('rp-entry-del')) return;
      e.stopPropagation();
      const date = entry.dataset.date;
      const log = reading.readingLog || {};
      container.querySelector('.rp-date').value = date;
      container.querySelector('.rp-pages').value = log[date] || '';
      container.querySelector('.rp-pages').focus();
    });
  });
  container.querySelectorAll('.rp-entry-del').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await chrome.runtime.sendMessage({ type: 'oc-log-pages', pageKey: reading.pageKey, date: btn.dataset.date, pages: 0 });
      await loadReadings();
      const newTr = document.querySelector(`tr.row[data-pk="${CSS.escape(reading.pageKey)}"]`);
      const newDetailTr = document.querySelector(`tr.detail-row[data-detail-pk="${CSS.escape(reading.pageKey)}"]`);
      const updated = allReadings.find(r => r.pageKey === reading.pageKey);
      if (newTr && newDetailTr && updated) toggleDetail(newTr, newDetailTr, updated);
    });
  });

  detailTr.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── Delete ───────────────────────────────────────────────────────
async function deleteReading(pageKey) {
  const { ocReadings = {} } = await chrome.storage.local.get('ocReadings');
  delete ocReadings[pageKey];
  await chrome.storage.local.set({ ocReadings });
  await chrome.storage.local.remove(pageKey);

  // Clean up IndexedDB transcript for library items
  if (pageKey.startsWith('library:')) {
    try {
      const req = indexedDB.open('marginaliaDB', 1);
      req.onsuccess = () => {
        const db = req.result;
        if (db.objectStoreNames.contains('transcripts')) {
          const tx = db.transaction('transcripts', 'readwrite');
          tx.objectStore('transcripts').delete(pageKey);
        }
        db.close();
      };
    } catch {}
  }

  allReadings = allReadings.filter(r => r.pageKey !== pageKey);
  document.getElementById('total-count').textContent =
    `${allReadings.length} reading${allReadings.length !== 1 ? 's' : ''}`;

  const dailyData = computeDailyData(allReadings);
  renderStats(computeStats(allReadings), dailyData);
  renderHeatmap(allReadings);
  renderTagFilters(allReadings);
  renderTable(getFilteredReadings());
}

// ── Filter ───────────────────────────────────────────────────────
function getFilteredReadings() {
  const query = document.getElementById('search').value.trim().toLowerCase();
  return allReadings.filter(r => {
    if (activeTag && !(r.tags || []).includes(activeTag)) return false;
    if (query) {
      const searchable = [
        r.title || '', r.author || '',
        (r.tags || []).join(' '), r.notes || ''
      ].join(' ').toLowerCase();
      if (!searchable.includes(query)) return false;
    }
    return true;
  });
}

document.getElementById('search').addEventListener('input', () => {
  renderTable(getFilteredReadings());
});

// Keyboard: "/" to focus search, Escape to close detail
document.addEventListener('keydown', e => {
  if (e.key === '/' && !e.ctrlKey && !e.metaKey && document.activeElement.tagName !== 'INPUT') {
    e.preventDefault();
    document.getElementById('search').focus();
  }
  if (e.key === 'Escape') {
    document.getElementById('search').blur();
    document.querySelectorAll('tr.detail-row.open').forEach(r => r.classList.remove('open'));
  }
});

// ── Date formatting ──────────────────────────────────────────────
function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatDate(iso) {
  if (!iso) return '\u2014';
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatDateFull(iso) {
  if (!iso) return '\u2014';
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric'
  });
}

// ── Export button ─────────────────────────────────────────────────
(function () {
  var btn = document.getElementById('nav-export-btn');
  if (!btn) return;
  btn.addEventListener('click', async function () {
    if (btn.classList.contains('syncing')) return;
    btn.classList.add('syncing');
    btn.textContent = 'Exporting\u2026';
    try {
      var count = await window.__marginaliaExport.exportToObsidian();
      btn.textContent = count + ' exported';
      setTimeout(function () { btn.textContent = 'Export'; }, 2000);
    } catch (err) {
      console.error('Export failed:', err);
      btn.textContent = 'Error';
      setTimeout(function () { btn.textContent = 'Export'; }, 2000);
    } finally {
      btn.classList.remove('syncing');
    }
  });
})();

// ── Init ─────────────────────────────────────────────────────────
loadReadings();

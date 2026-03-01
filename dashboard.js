// ── HTML escaping ────────────────────────────────────────────────
function esc(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ── Tag color palette ────────────────────────────────────────────
const TAG_COLORS = {
  'AI/ML Research':         '#e8a87c',
  'Healthcare/Bio':         '#6fcf97',
  'General Learning':       '#7ca8e8',
  'Framework/Mental Model': '#b87ce8',
  'Future Exploration':     '#e8d47c',
  'To Revisit':             '#e87c7c'
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

  document.getElementById('total-count').textContent =
    `${allReadings.length} reading${allReadings.length !== 1 ? 's' : ''}`;

  renderStats(computeStats(allReadings));
  renderHeatmap(allReadings);
  renderTagFilters(allReadings);
  renderTable(getFilteredReadings());
}

// ── Stats ────────────────────────────────────────────────────────
function computeStats(readings) {
  const totalPages = readings.reduce((sum, r) => sum + (r.estPages || 0), 0);
  const totalReadings = readings.length;
  const streak = computeStreak(readings);

  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  weekAgo.setHours(0, 0, 0, 0);
  const weekPages = readings
    .filter(r => r.createdAt && new Date(r.createdAt) >= weekAgo)
    .reduce((sum, r) => sum + (r.estPages || 0), 0);

  return { totalPages, totalReadings, streak, weekPages };
}

function computeStreak(readings) {
  const days = new Set();
  for (const r of readings) {
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

function renderStats(stats) {
  const grid = document.getElementById('stats-grid');
  const items = [
    { value: stats.totalPages, label: 'Pages Read' },
    { value: stats.totalReadings, label: 'Readings' },
    { value: stats.streak, label: 'Day Streak' },
    { value: stats.weekPages, label: 'Pages This Week' },
  ];

  grid.innerHTML = items.map(item => `
    <div class="stat-card animate-in">
      <div class="stat-value" data-target="${item.value}">0</div>
      <div class="stat-label">${item.label}</div>
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
    if (!r.createdAt) continue;
    const key = localDateStr(new Date(r.createdAt));
    dayPages[key] = (dayPages[key] || 0) + (r.estPages || 0);
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

    html += `<tr class="row" data-pk="${esc(r.pageKey)}" style="--row-accent:${color}">
      <td class="col-title" title="${esc(r.title)}">${titlePrefix}${esc(r.title || '(untitled)')}</td>
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
  if (reading.notes) metaHtml += `<div class="detail-notes">${esc(reading.notes)}</div>`;
  metaHtml += '</div>';

  // Right column: highlights
  let hlHtml = `<div><h4 class="detail-section-title">Highlights (${highlights.length})</h4>`;
  if (highlights.length) {
    hlHtml += '<ul class="detail-hl-list">';
    for (const h of highlights) {
      hlHtml += '<li class="detail-hl-item">';
      hlHtml += `<div class="detail-hl-quote">"${esc(h.text)}"</div>`;
      if (h.comment) hlHtml += `<div class="detail-hl-comment">${esc(h.comment)}</div>`;
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

  container.innerHTML = `<div class="detail-panel">
    <div style="display:flex;justify-content:flex-start;gap:10px;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid #1e1e1e;">${openReaderBtnHtml}${deleteBtnHtml}</div>
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

  renderStats(computeStats(allReadings));
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

// ── Init ─────────────────────────────────────────────────────────
loadReadings();

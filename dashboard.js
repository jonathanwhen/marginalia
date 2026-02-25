// ── HTML escaping to prevent XSS ─────────────────────────────────
function esc(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ── State ────────────────────────────────────────────────────────
let allReadings = [];       // [{pageKey, ...reading, hlCount}]
let sortCol = 'date';       // current sort column
let sortAsc = false;        // false = descending (most recent first)

// ── Column definitions ──────────────────────────────────────────
const COLUMNS = [
  { key: 'title',   label: 'Title',     cls: 'col-title' },
  { key: 'author',  label: 'Author',    cls: 'col-author' },
  { key: 'tags',    label: 'Tags',      cls: 'col-tags' },
  { key: 'pages',   label: 'Est. Pages',cls: 'col-pages' },
  { key: 'notes',   label: 'Notes',     cls: 'col-notes' },
  { key: 'hl',      label: 'Highlights',cls: 'col-hl' },
  { key: 'date',    label: 'Date',      cls: 'col-date' },
];

// ── Load readings + batch-fetch highlight counts ─────────────────
async function loadReadings() {
  const { ocReadings = {} } = await chrome.storage.local.get('ocReadings');
  const pageKeys = Object.keys(ocReadings);

  // Batch-fetch all page keys at once to get highlight arrays
  const hlData = pageKeys.length ? await chrome.storage.local.get(pageKeys) : {};

  allReadings = pageKeys.map(pageKey => {
    const r = ocReadings[pageKey];
    const highlights = hlData[pageKey];
    // hlData[pageKey] could be the reading itself if pageKey collides with
    // a storage key format, so only count arrays.
    const hlCount = Array.isArray(highlights) ? highlights.length : 0;
    return { pageKey, ...r, hlCount };
  });

  document.getElementById('total-count').textContent =
    `${allReadings.length} reading${allReadings.length !== 1 ? 's' : ''}`;

  renderTable(allReadings);
}

// ── Render table ─────────────────────────────────────────────────
function renderTable(readings) {
  const wrap = document.getElementById('table-wrap');

  if (!readings.length) {
    wrap.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🦞</div>
        <p>No readings yet</p>
        <div class="hint">Use the popup to log your first reading.</div>
      </div>`;
    return;
  }

  const sorted = sortReadings(readings);
  const arrow = sortAsc ? '&#9650;' : '&#9660;';

  let html = '<table><thead><tr>';
  for (const col of COLUMNS) {
    const isActive = sortCol === col.key;
    html += `<th class="${col.cls}" data-col="${col.key}">${esc(col.label)}`;
    if (isActive) html += `<span class="sort-arrow">${arrow}</span>`;
    html += '</th>';
  }
  html += '</tr></thead><tbody>';

  for (const r of sorted) {
    const dateStr = formatDate(r.createdAt);
    const tagsHtml = (r.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('');
    const notesPreview = (r.notes || '').length > 60
      ? esc(r.notes.slice(0, 60)) + '\u2026'
      : esc(r.notes || '');
    const hlDisplay = r.hlCount > 0
      ? `<span class="hl-count">${r.hlCount}</span>`
      : '<span style="color:#333">0</span>';

    html += `<tr class="row" data-pk="${esc(r.pageKey)}">
      <td class="col-title" title="${esc(r.title)}">${esc(r.title || '(untitled)')}</td>
      <td class="col-author">${esc(r.author || '\u2014')}</td>
      <td class="col-tags">${tagsHtml || '<span style="color:#333">\u2014</span>'}</td>
      <td class="col-pages">${r.estPages || '\u2014'}</td>
      <td class="col-notes"><span class="notes-preview">${notesPreview || '<span style="color:#333">\u2014</span>'}</span></td>
      <td class="col-hl">${hlDisplay}</td>
      <td class="col-date">${esc(dateStr)}</td>
    </tr>`;

    // Hidden detail row (populated on expand)
    html += `<tr class="detail-row" data-detail-pk="${esc(r.pageKey)}">
      <td colspan="${COLUMNS.length}"><div class="detail-content">Loading...</div></td>
    </tr>`;
  }

  html += '</tbody></table>';
  wrap.innerHTML = html;

  // Wire up sort headers
  wrap.querySelectorAll('thead th').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (sortCol === col) {
        sortAsc = !sortAsc;
      } else {
        sortCol = col;
        sortAsc = col === 'title' || col === 'author'; // alpha cols default ascending
      }
      renderTable(getFilteredReadings());
    });
  });

  // Wire up row expand/collapse
  wrap.querySelectorAll('tr.row').forEach(tr => {
    tr.addEventListener('click', () => {
      const pk = tr.dataset.pk;
      const detailTr = wrap.querySelector(`tr.detail-row[data-detail-pk="${CSS.escape(pk)}"]`);
      toggleDetail(tr, detailTr, allReadings.find(r => r.pageKey === pk));
    });
  });
}

// ── Sort readings ────────────────────────────────────────────────
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
      case 'notes':  va = (a.notes || '').toLowerCase(); vb = (b.notes || '').toLowerCase(); break;
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

// ── Toggle detail row ────────────────────────────────────────────
async function toggleDetail(tr, detailTr, reading) {
  if (detailTr.classList.contains('open')) {
    detailTr.classList.remove('open');
    return;
  }

  // Close any other open detail rows
  document.querySelectorAll('tr.detail-row.open').forEach(r => r.classList.remove('open'));

  detailTr.classList.add('open');

  if (!reading) {
    detailTr.querySelector('.detail-content').innerHTML = '<span style="color:#555">Reading not found.</span>';
    return;
  }

  // Lazy-load full highlights from per-page storage
  const hlResult = await chrome.storage.local.get([reading.pageKey]);
  const highlights = Array.isArray(hlResult[reading.pageKey]) ? hlResult[reading.pageKey] : [];

  const container = detailTr.querySelector('.detail-content');

  // Left: metadata + notes
  let metaHtml = '<div class="detail-section"><h4>Details</h4><div class="detail-meta">';
  metaHtml += `<div><span class="meta-label">Title:</span> ${esc(reading.title || '')}</div>`;
  if (reading.author) metaHtml += `<div><span class="meta-label">Author:</span> ${esc(reading.author)}</div>`;
  if (reading.tags?.length) metaHtml += `<div><span class="meta-label">Tags:</span> ${reading.tags.map(t => esc(t)).join(', ')}</div>`;
  if (reading.estPages) metaHtml += `<div><span class="meta-label">Est. Pages:</span> ${reading.estPages}</div>`;
  if (reading.url) metaHtml += `<div><span class="meta-label">URL:</span> <a href="${esc(reading.url)}" target="_blank" rel="noopener">${esc(reading.url)}</a></div>`;
  metaHtml += `<div><span class="meta-label">Logged:</span> ${esc(formatDate(reading.createdAt))}</div>`;
  if (reading.updatedAt !== reading.createdAt) {
    metaHtml += `<div><span class="meta-label">Updated:</span> ${esc(formatDate(reading.updatedAt))}</div>`;
  }
  metaHtml += '</div>';
  if (reading.notes) metaHtml += `<div class="detail-notes">${esc(reading.notes)}</div>`;
  metaHtml += '</div>';

  // Right: highlights
  let hlHtml = '<div class="detail-section"><h4>Highlights (' + highlights.length + ')</h4>';
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

  const actionsHtml = `<div class="detail-actions">
    <button class="delete-btn" data-pk="${esc(reading.pageKey)}">Delete Reading</button>
  </div>`;

  container.innerHTML = `<div class="detail-grid">${metaHtml}${hlHtml}</div>${actionsHtml}`;

  // Wire up delete with confirmation
  const deleteBtn = container.querySelector('.delete-btn');
  let confirmPending = false;
  deleteBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirmPending) {
      confirmPending = true;
      deleteBtn.textContent = 'Click again to confirm';
      deleteBtn.classList.add('confirm');
      // Reset after 3s if not confirmed
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
}

// ── Delete a reading + its highlights from storage ───────────────
async function deleteReading(pageKey) {
  const { ocReadings = {} } = await chrome.storage.local.get('ocReadings');
  delete ocReadings[pageKey];
  await chrome.storage.local.set({ ocReadings });

  // Also remove per-page highlights if they exist
  await chrome.storage.local.remove(pageKey);

  // Remove from in-memory list and re-render
  allReadings = allReadings.filter(r => r.pageKey !== pageKey);
  document.getElementById('total-count').textContent =
    `${allReadings.length} reading${allReadings.length !== 1 ? 's' : ''}`;
  renderTable(getFilteredReadings());
}

// ── Search / filter ──────────────────────────────────────────────
function getFilteredReadings() {
  const query = document.getElementById('search').value.trim().toLowerCase();
  if (!query) return allReadings;

  return allReadings.filter(r => {
    const searchable = [
      r.title || '',
      r.author || '',
      (r.tags || []).join(' '),
      r.notes || ''
    ].join(' ').toLowerCase();
    return searchable.includes(query);
  });
}

document.getElementById('search').addEventListener('input', () => {
  renderTable(getFilteredReadings());
});

// ── Date formatting ──────────────────────────────────────────────
function formatDate(iso) {
  if (!iso) return '\u2014';
  const d = new Date(iso);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

// ── Init ─────────────────────────────────────────────────────────
loadReadings();

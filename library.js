import * as pdfjsLib from './lib/pdf.min.mjs';
import { getAllTranscriptsMeta, putTranscript, hasTranscript, deleteTranscript } from './lib/db.js';
import { classifyReading } from './lib/classify.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.mjs');

// ── Tag colors (matches dashboard.js) ────────────────────────────────
const TAG_COLORS = {
  'AI/ML Research':     '#e8a87c',
  'Healthcare/Bio':     '#6fcf97',
  'Philosophy':         '#b87ce8',
  'Economics/Finance':  '#e8d47c',
  'Research Craft':     '#7cc8e8',
  'General Learning':   '#7ca8e8',
  'To Revisit':         '#e87c7c'
};
function getTagColor(tag) { return TAG_COLORS[tag] || '#888'; }

// ── State ────────────────────────────────────────────────────────────
let allTranscripts = [];
let activeTag = null;
let sortKey = 'importedAt';
let sortAsc = false;

// ── DOM refs ─────────────────────────────────────────────────────────
const importZone = document.getElementById('import-zone');
const fileInput = document.getElementById('file-input');
const folderInput = document.getElementById('folder-input');
const progressOverlay = document.getElementById('progress-overlay');
const progressFill = document.getElementById('progress-fill');
const progressStatus = document.getElementById('progress-status');
const progressCurrent = document.getElementById('progress-current');
const toolbar = document.getElementById('lib-toolbar');
const searchInput = document.getElementById('search');
const tagFilters = document.getElementById('tag-filters');
const sortSelect = document.getElementById('sort-select');
const grid = document.getElementById('transcript-grid');
const countEl = document.getElementById('lib-count');

// ── Import: file/folder selection ────────────────────────────────────
document.getElementById('btn-files').addEventListener('click', (e) => {
  e.stopPropagation();
  fileInput.click();
});
document.getElementById('btn-folder').addEventListener('click', (e) => {
  e.stopPropagation();
  folderInput.click();
});
importZone.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', (e) => {
  const files = Array.from(e.target.files).filter(f => f.type === 'application/pdf');
  if (files.length) importFiles(files);
  fileInput.value = '';
});
folderInput.addEventListener('change', (e) => {
  const files = Array.from(e.target.files).filter(f => f.type === 'application/pdf');
  if (files.length) importFiles(files);
  folderInput.value = '';
});

// ── Import: drag and drop ────────────────────────────────────────────
let dragCounter = 0;
importZone.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragCounter++;
  if (dragCounter === 1) importZone.classList.add('dragover');
});
importZone.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragCounter--;
  if (dragCounter === 0) importZone.classList.remove('dragover');
});
importZone.addEventListener('dragover', (e) => e.preventDefault());
importZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dragCounter = 0;
  importZone.classList.remove('dragover');
  const files = Array.from(e.dataTransfer.files).filter(f => f.type === 'application/pdf');
  if (files.length) importFiles(files);
});

// ── Import pipeline ──────────────────────────────────────────────────
// Processes files sequentially to avoid memory pressure from multiple
// simultaneous PDF parses.
async function importFiles(files) {
  progressOverlay.classList.remove('hidden');
  let imported = 0;
  let skipped = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    progressStatus.textContent = `${i + 1} / ${files.length}`;
    progressCurrent.textContent = file.name;
    progressFill.style.width = `${((i) / files.length) * 100}%`;

    try {
      const result = await importSingleFile(file);
      if (result === 'duplicate') skipped++;
      else imported++;
    } catch (err) {
      console.error(`Failed to import ${file.name}:`, err);
      skipped++;
    }
  }

  progressFill.style.width = '100%';
  progressStatus.textContent = `Done — ${imported} imported, ${skipped} skipped`;
  progressCurrent.textContent = '';

  // Close overlay after a short delay
  setTimeout(() => {
    progressOverlay.classList.add('hidden');
    progressFill.style.width = '0';
  }, 1500);

  await loadTranscripts();
}

async function importSingleFile(file) {
  const arrayBuffer = await file.arrayBuffer();

  // Content-hash pageKey (same algo as reader.js:153-158)
  const hashData = arrayBuffer.slice(0, 65536);
  const hashBuffer = await crypto.subtle.digest('SHA-256', hashData);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  const pageKey = `library:${hashHex}-${arrayBuffer.byteLength}-${file.name}`;

  // Dedup check
  if (await hasTranscript(pageKey)) return 'duplicate';

  // Load PDF doc to get page count + extract plain text for search
  const doc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const { plainText, wordCount } = await extractPlainText(doc);

  // Derive title from filename: strip extension, replace separators
  const title = file.name
    .replace(/\.pdf$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim();

  // Auto-classify based on filename + content
  const autoTag = classifyReading(title, file.name, plainText);

  const transcript = {
    pageKey,
    title,
    author: '',
    pdfData: arrayBuffer,      // raw PDF bytes for canvas rendering
    content: plainText,         // plain text for library search only
    fileName: file.name,
    fileHash: hashHex,
    byteSize: arrayBuffer.byteLength,
    pageCount: doc.numPages,
    wordCount,
    importedAt: new Date().toISOString(),
    tags: [autoTag],
    format: 'pdf'
  };

  await putTranscript(transcript);

  // Create reading entry in chrome.storage.local so it appears on dashboard + syncs
  await chrome.runtime.sendMessage({
    type: 'oc-upsert-reading',
    pageKey,
    title,
    url: pageKey,
    tags: [autoTag],
    estPages: doc.numPages
  });

  return 'imported';
}

// ── Plain text extraction (for search indexing only) ─────────────────
// PDF rendering is handled by the canvas reader (library-reader.js).
// We just need plain text for the library search/filter functionality.
async function extractPlainText(doc) {
  let fullText = '';
  let wordCount = 0;
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const text = tc.items.map(item => item.str).join(' ');
    fullText += text + '\n';
    wordCount += text.split(/\s+/).filter(Boolean).length;
  }
  return { plainText: fullText, wordCount };
}

function escHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Load and render transcripts ──────────────────────────────────────
async function loadTranscripts() {
  allTranscripts = await getAllTranscriptsMeta();

  // Enrich with highlight counts from chrome.storage.local
  if (allTranscripts.length) {
    const keys = allTranscripts.map(t => t.pageKey);
    const hlData = await chrome.storage.local.get(keys);
    for (const t of allTranscripts) {
      const hl = hlData[t.pageKey];
      t.hlCount = Array.isArray(hl) ? hl.length : 0;
    }
  }

  countEl.textContent = `${allTranscripts.length} transcript${allTranscripts.length !== 1 ? 's' : ''}`;
  toolbar.style.display = allTranscripts.length > 0 ? 'flex' : 'none';

  renderTagFilters();
  renderGrid();
}

// ── Filtering ────────────────────────────────────────────────────────
function getFiltered() {
  const query = searchInput.value.trim().toLowerCase();
  return allTranscripts.filter(t => {
    if (activeTag && !(t.tags || []).includes(activeTag)) return false;
    if (query) {
      const searchable = [
        t.title || '', t.author || '', (t.tags || []).join(' ')
      ].join(' ').toLowerCase();
      // Also search content, but truncate for performance
      const contentSnippet = (t.content || '').toLowerCase().slice(0, 10000);
      if (!searchable.includes(query) && !contentSnippet.includes(query)) return false;
    }
    return true;
  });
}

// ── Sorting ──────────────────────────────────────────────────────────
function sortTranscripts(transcripts) {
  const copy = [...transcripts];
  const dir = sortAsc ? 1 : -1;

  copy.sort((a, b) => {
    let va, vb;
    switch (sortKey) {
      case 'title': va = (a.title || '').toLowerCase(); vb = (b.title || '').toLowerCase(); break;
      case 'importedAt': va = a.importedAt || ''; vb = b.importedAt || ''; break;
      case 'pageCount': va = a.pageCount || 0; vb = b.pageCount || 0; break;
      case 'wordCount': va = a.wordCount || 0; vb = b.wordCount || 0; break;
      default: va = ''; vb = '';
    }
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return 0;
  });
  return copy;
}

sortSelect.addEventListener('change', () => {
  const [key, dir] = sortSelect.value.split('-');
  sortKey = key;
  sortAsc = dir === 'asc';
  renderGrid();
});

// ── Tag filters ──────────────────────────────────────────────────────
function renderTagFilters() {
  const tagCounts = {};
  for (const t of allTranscripts) {
    for (const tag of (t.tags || [])) {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }
  }

  const tags = Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([tag]) => tag);

  if (!tags.length) { tagFilters.innerHTML = ''; return; }

  tagFilters.innerHTML = tags.map(tag => {
    const color = getTagColor(tag);
    const isActive = activeTag === tag;
    const activeStyle = isActive
      ? `border-color:${color}; color:${color}; background:color-mix(in srgb, ${color} 10%, transparent);`
      : '';
    return `<button class="tag-pill${isActive ? ' active' : ''}" data-tag="${escAttr(tag)}" style="${activeStyle}">${escHtml(tag)}</button>`;
  }).join('');

  tagFilters.querySelectorAll('.tag-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      activeTag = activeTag === btn.dataset.tag ? null : btn.dataset.tag;
      renderTagFilters();
      renderGrid();
    });
  });
}

function escAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;');
}

// ── Render grid ──────────────────────────────────────────────────────
function renderGrid() {
  const filtered = getFiltered();
  const sorted = sortTranscripts(filtered);

  if (!sorted.length) {
    const hasFilter = activeTag || searchInput.value.trim();
    grid.innerHTML = hasFilter
      ? `<div class="empty-state"><p>No transcripts match your search</p>
         <div class="hint">Try a different term or clear filters.</div></div>`
      : '';
    return;
  }

  grid.innerHTML = sorted.map(t => {
    const tagsHtml = (t.tags || []).map(tag => {
      const color = getTagColor(tag);
      return `<span class="card-tag" style="border-color:${color}; color:${color}; background:color-mix(in srgb, ${color} 10%, transparent);">${escHtml(tag)}</span>`;
    }).join('');

    const preview = (t.content || '').slice(0, 200);

    return `<div class="transcript-card" data-key="${escAttr(t.pageKey)}">
      <div class="card-title">${escHtml(t.title || '(untitled)')}</div>
      ${t.author ? `<div class="card-author">${escHtml(t.author)}</div>` : ''}
      <div class="card-meta">
        <span>${t.pageCount || 0} pages</span>
        <span>${(t.wordCount || 0).toLocaleString()} words</span>
        ${t.hlCount > 0 ? `<span style="color:var(--accent);">${t.hlCount} highlights</span>` : ''}
      </div>
      ${tagsHtml ? `<div class="card-tags">${tagsHtml}</div>` : ''}
      <div class="card-preview">${escHtml(preview)}</div>
      <div class="card-actions">
        <button class="card-delete" data-key="${escAttr(t.pageKey)}">Delete</button>
      </div>
    </div>`;
  }).join('');

  // Wire card clicks → open reader
  grid.querySelectorAll('.transcript-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.card-delete')) return;
      const key = card.dataset.key;
      const readerUrl = chrome.runtime.getURL(`library-reader.html?key=${encodeURIComponent(key)}`);
      window.location.href = readerUrl;
    });
  });

  // Wire delete buttons
  grid.querySelectorAll('.card-delete').forEach(btn => {
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
      await deleteLibraryItem(btn.dataset.key);
    });
  });
}

// ── Delete a library item ────────────────────────────────────────────
// Removes from IndexedDB + ocReadings + highlights in chrome.storage.local
async function deleteLibraryItem(pageKey) {
  await deleteTranscript(pageKey);

  // Remove from ocReadings
  const { ocReadings = {} } = await chrome.storage.local.get('ocReadings');
  delete ocReadings[pageKey];
  await chrome.storage.local.set({ ocReadings });

  // Remove highlights + reading position
  await chrome.storage.local.remove([pageKey, `pos:${pageKey}`]);

  await loadTranscripts();
}

// ── Search (debounced) ───────────────────────────────────────────────
let searchTimer = null;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => renderGrid(), 300);
});

// ── Keyboard shortcuts ───────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !e.ctrlKey && !e.metaKey && document.activeElement.tagName !== 'INPUT') {
    e.preventDefault();
    searchInput.focus();
  }
  if (e.key === 'Escape') {
    searchInput.blur();
  }
});

// ── Init ─────────────────────────────────────────────────────────────
loadTranscripts();

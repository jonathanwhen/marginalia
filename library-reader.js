import { getTranscript } from './lib/db.js';

// ── State ────────────────────────────────────────────────────────────
let currentPageKey = null;
let highlights = [];
let highlightMode = false;
let sidebarSaveTimer = null;

// ── DOM refs ─────────────────────────────────────────────────────────
const article = document.getElementById('article');
const toolbarTitle = document.getElementById('toolbar-title');
const sidebar = document.getElementById('sidebar');
const sbNotes = document.getElementById('sb-notes');
const sbStatus = document.getElementById('sb-status');
const sbHlHeader = document.getElementById('sb-hl-header');
const sbHlList = document.getElementById('sb-hl-list');
const hlToolbar = document.getElementById('hl-toolbar');
const annPopup = document.getElementById('ann-popup');
const annInput = document.getElementById('ann-input');
const noteBubble = document.getElementById('note-bubble');
const modeBanner = document.getElementById('mode-banner');

// ── Load transcript from IndexedDB ───────────────────────────────────
const params = new URLSearchParams(location.search);
const pageKey = params.get('key');

if (pageKey) {
  currentPageKey = pageKey;
  loadTranscript(pageKey);
} else {
  article.innerHTML = '<p style="color:#555;">No transcript key provided.</p>';
}

async function loadTranscript(key) {
  const transcript = await getTranscript(key);
  if (!transcript) {
    article.innerHTML = '<p style="color:#555;">Transcript not found.</p>';
    return;
  }

  document.title = `Marginalia — ${transcript.title}`;
  toolbarTitle.textContent = transcript.title;
  article.innerHTML = transcript.content;

  // Load highlights and apply
  await loadHighlights();
  applyStoredHighlights();

  // Load sidebar notes
  loadSidebarNotes();
  refreshSidebarHighlights();
}

// ── Storage helpers (direct chrome.storage.local — extension page) ───
async function loadHighlights() {
  if (!currentPageKey) { highlights = []; return; }
  const result = await chrome.storage.local.get([currentPageKey]);
  highlights = result[currentPageKey] || [];
}

async function saveHighlightsToStorage() {
  if (!currentPageKey) return;
  await chrome.storage.local.set({ [currentPageKey]: highlights });
}

// ── Apply stored highlights to rendered HTML ─────────────────────────
// Uses DOM text-node walking (same approach as content.js)
function applyStoredHighlights() {
  for (const h of highlights) {
    injectHighlight(h);
  }
}

function injectHighlight(h) {
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const idx = node.nodeValue.indexOf(h.text);
    if (idx === -1) continue;
    const range = document.createRange();
    range.setStart(node, idx);
    range.setEnd(node, idx + h.text.length);
    wrapRange(range, h);
    break;
  }
}

function wrapRange(range, h) {
  try {
    const mark = document.createElement('mark');
    mark.className = 'oc-highlight' + (h.comment ? ' oc-highlight-comment' : '');
    mark.dataset.ocId = h.id;
    mark.title = h.comment || '';
    range.surroundContents(mark);
    mark.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!highlightMode) showNoteBubble(e, mark, h);
    });
    return mark;
  } catch {
    return wrapRangeMulti(range, h);
  }
}

function wrapRangeMulti(range, h) {
  const textNodes = [];
  const walker = document.createTreeWalker(
    range.commonAncestorContainer,
    NodeFilter.SHOW_TEXT
  );
  let node;
  while ((node = walker.nextNode())) {
    if (range.intersectsNode(node)) textNodes.push(node);
  }
  if (textNodes.length === 0) return null;

  let firstMark = null;
  for (const tNode of textNodes) {
    let start = 0;
    let end = tNode.nodeValue.length;
    if (tNode === range.startContainer) start = range.startOffset;
    if (tNode === range.endContainer) end = range.endOffset;
    if (start >= end) continue;

    if (end < tNode.nodeValue.length) tNode.splitText(end);
    const target = start > 0 ? tNode.splitText(start) : tNode;

    const mark = document.createElement('mark');
    mark.className = 'oc-highlight' + (h.comment ? ' oc-highlight-comment' : '');
    mark.dataset.ocId = h.id;
    mark.title = h.comment || '';
    target.parentNode.insertBefore(mark, target);
    mark.appendChild(target);
    mark.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!highlightMode) showNoteBubble(e, mark, h);
    });
    if (!firstMark) firstMark = mark;
  }
  return firstMark;
}

// ── Save a new highlight ─────────────────────────────────────────────
let lastSavedText = '';
let lastSavedTime = 0;

function saveHighlight(text, range, comment, onDone) {
  const now = Date.now();
  if (text === lastSavedText && now - lastSavedTime < 2000) return;

  const h = {
    id: now.toString(),
    text,
    comment,
    timestamp: new Date().toISOString()
  };

  const mark = wrapRange(range, h);
  if (!mark) return;

  lastSavedText = text;
  lastSavedTime = now;
  window.getSelection()?.removeAllRanges();

  highlights.push(h);
  saveHighlightsToStorage();
  ensureReadingExists();
  notifyHighlightChanged('create', text, h.id);
  refreshSidebarHighlights();

  if (onDone) onDone(h, mark);
}

function deleteHighlight(id) {
  document.querySelectorAll(`mark[data-oc-id="${id}"]`).forEach(mark => {
    const parent = mark.parentNode;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  });
  highlights = highlights.filter(h => h.id !== id);
  saveHighlightsToStorage();
  notifyHighlightChanged('delete', '', id);
  refreshSidebarHighlights();
}

function updateHighlightComment(id, comment) {
  const h = highlights.find(hl => hl.id === id);
  if (!h) return;
  h.comment = comment;

  // Update DOM marks
  document.querySelectorAll(`mark[data-oc-id="${id}"]`).forEach(mark => {
    mark.className = 'oc-highlight' + (comment ? ' oc-highlight-comment' : '');
    mark.title = comment;
  });

  saveHighlightsToStorage();
  ensureReadingExists();
  notifyHighlightChanged('update', h.text, h.id);
  refreshSidebarHighlights();
}

// ── Background communication ─────────────────────────────────────────
function ensureReadingExists() {
  if (!currentPageKey) return;
  try {
    chrome.runtime.sendMessage({
      type: 'oc-upsert-reading',
      pageKey: currentPageKey,
      title: toolbarTitle.textContent || currentPageKey,
      url: currentPageKey
    });
  } catch {}
}

function notifyHighlightChanged(action, text, highlightId) {
  if (!currentPageKey) return;
  try {
    chrome.runtime.sendMessage({
      type: 'oc-highlight-changed',
      pageKey: currentPageKey,
      action,
      text,
      highlightId
    });
  } catch {}
}

// ── Selection listener ───────────────────────────────────────────────
document.addEventListener('mouseup', (e) => {
  if (hlToolbar.contains(e.target)) return;
  if (modeBanner.contains(e.target)) return;
  if (noteBubble.contains(e.target)) return;
  if (annPopup.contains(e.target)) return;
  if (sidebar.contains(e.target)) return;

  hideNoteBubble();

  setTimeout(() => {
    const sel = window.getSelection();
    const text = sel?.toString().trim();
    if (!text || text.length < 2) {
      if (!highlightMode) hideHlToolbar();
      return;
    }

    const range = sel.getRangeAt(0);

    // Ensure selection is within the article
    if (!article.contains(range.commonAncestorContainer)) {
      hideHlToolbar();
      return;
    }

    if (highlightMode) {
      hideAnnPopup();
      const clonedRange = range.cloneRange();
      sel.removeAllRanges();
      saveHighlight(text, clonedRange, '', (h, mark) => {
        if (mark) showAnnotationPopup(mark, h);
      });
    } else {
      const rect = range.getBoundingClientRect();
      showHlToolbar(rect, text, range);
    }
  }, 10);
});

document.addEventListener('mousedown', (e) => {
  if (!hlToolbar.contains(e.target) && !hlToolbar.classList.contains('hidden')) hideHlToolbar();
  if (!noteBubble.contains(e.target) && !noteBubble.classList.contains('hidden')) hideNoteBubble();
  if (!annPopup.contains(e.target) && !annPopup.classList.contains('hidden')) hideAnnPopup();
});

// ── Highlight toolbar ────────────────────────────────────────────────
let pendingText = null;
let pendingRange = null;

function showHlToolbar(rect, text, range) {
  pendingText = text;
  pendingRange = range.cloneRange();

  const vw = window.innerWidth;
  hlToolbar.classList.remove('hidden');
  let x = rect.left + rect.width / 2 + window.scrollX - hlToolbar.offsetWidth / 2;
  x = Math.max(8, Math.min(x, vw - hlToolbar.offsetWidth - 8));
  let y = rect.top + window.scrollY - 48;
  y = Math.max(8, y);

  hlToolbar.style.left = x + 'px';
  hlToolbar.style.top = y + 'px';
}

function hideHlToolbar() { hlToolbar.classList.add('hidden'); }

document.getElementById('hl-btn-highlight').addEventListener('click', (e) => {
  e.stopPropagation();
  if (!pendingText || !pendingRange) return;
  saveHighlight(pendingText, pendingRange, '');
  hideHlToolbar();
});

document.getElementById('hl-btn-comment').addEventListener('click', (e) => {
  e.stopPropagation();
  if (!pendingText || !pendingRange) return;
  hideHlToolbar();
  saveHighlight(pendingText, pendingRange, '', (h, mark) => {
    if (mark) showAnnotationPopup(mark, h);
  });
});

// ── Annotation popup ─────────────────────────────────────────────────
function showAnnotationPopup(mark, h) {
  hideAnnPopup();
  const rect = mark.getBoundingClientRect();
  const vw = window.innerWidth;
  let px = rect.left + window.scrollX;
  px = Math.max(8, Math.min(px, vw - 270));

  annPopup.style.left = px + 'px';
  annPopup.style.top = (rect.bottom + window.scrollY + 4) + 'px';
  annPopup.classList.remove('hidden');
  annInput.value = '';
  annInput.focus();

  annInput.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      const comment = annInput.value.trim();
      if (comment) updateHighlightComment(h.id, comment);
      hideAnnPopup();
    }
    if (e.key === 'Escape') hideAnnPopup();
  };
}

function hideAnnPopup() { annPopup.classList.add('hidden'); annInput.onkeydown = null; }

// ── Note bubble ──────────────────────────────────────────────────────
function showNoteBubble(event, anchor, h) {
  hideNoteBubble();
  hideHlToolbar();

  const hasComment = !!h.comment;
  noteBubble.innerHTML = `
    <div class="nb-quote">${escHtml(h.text.length > 120 ? h.text.slice(0, 120) + '\u2026' : h.text)}</div>
    ${hasComment ? `<div class="nb-comment">${escHtml(h.comment)}</div>` : ''}
    <div class="nb-edit-section" style="display:none;">
      <textarea class="nb-edit-input" placeholder="Add a note...">${escHtml(h.comment || '')}</textarea>
      <div class="nb-edit-actions">
        <button class="nb-edit-save">Save</button>
        <button class="nb-edit-cancel">Cancel</button>
      </div>
    </div>
    <div class="nb-actions">
      <span class="nb-edit-btn">${hasComment ? '\u270E Edit note' : '\u270E Add note'}</span>
      <span class="nb-delete">\u2715 Remove</span>
    </div>
  `;

  const x = Math.max(8, Math.min(event.clientX - 30 + window.scrollX, window.innerWidth - 300));
  const y = event.clientY + window.scrollY + 10;
  noteBubble.style.left = x + 'px';
  noteBubble.style.top = y + 'px';
  noteBubble.classList.remove('hidden');

  // Delete
  noteBubble.querySelector('.nb-delete').addEventListener('click', () => {
    deleteHighlight(h.id);
    hideNoteBubble();
  });

  // Edit
  const editSection = noteBubble.querySelector('.nb-edit-section');
  const editInput = noteBubble.querySelector('.nb-edit-input');
  const commentDiv = noteBubble.querySelector('.nb-comment');
  const actionsDiv = noteBubble.querySelector('.nb-actions');

  noteBubble.querySelector('.nb-edit-btn').addEventListener('click', () => {
    editSection.style.display = 'block';
    actionsDiv.style.display = 'none';
    if (commentDiv) commentDiv.style.display = 'none';
    editInput.focus();
    editInput.setSelectionRange(editInput.value.length, editInput.value.length);
  });

  noteBubble.querySelector('.nb-edit-save').addEventListener('click', () => {
    updateHighlightComment(h.id, editInput.value.trim());
    hideNoteBubble();
  });

  noteBubble.querySelector('.nb-edit-cancel').addEventListener('click', () => {
    editSection.style.display = 'none';
    actionsDiv.style.display = '';
    if (commentDiv) commentDiv.style.display = '';
  });

  editInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      noteBubble.querySelector('.nb-edit-save').click();
    }
    if (e.key === 'Escape') {
      noteBubble.querySelector('.nb-edit-cancel').click();
    }
  });
}

function hideNoteBubble() { noteBubble.classList.add('hidden'); }

// ── Highlight mode ───────────────────────────────────────────────────
const btnHighlightMode = document.getElementById('btn-highlight-mode');

btnHighlightMode.addEventListener('click', () => {
  if (highlightMode) exitHighlightMode();
  else enterHighlightMode();
});

function enterHighlightMode() {
  highlightMode = true;
  btnHighlightMode.classList.add('active');
  modeBanner.classList.remove('hidden');
  hideHlToolbar();
  hideNoteBubble();
  hideAnnPopup();
}

function exitHighlightMode() {
  highlightMode = false;
  btnHighlightMode.classList.remove('active');
  modeBanner.classList.add('hidden');
  hideAnnPopup();
  window.getSelection()?.removeAllRanges();
}

document.getElementById('banner-exit').addEventListener('click', exitHighlightMode);

// ── Sidebar ──────────────────────────────────────────────────────────
const btnSidebar = document.getElementById('btn-sidebar');

btnSidebar.addEventListener('click', toggleSidebar);
document.getElementById('sb-close').addEventListener('click', toggleSidebar);

function toggleSidebar() {
  if (sidebar.classList.contains('hidden')) {
    sidebar.classList.remove('hidden');
    btnSidebar.classList.add('active');
    document.body.classList.add('sidebar-open');
    loadSidebarNotes();
    refreshSidebarHighlights();
  } else {
    // Flush pending note save
    if (sidebarSaveTimer) {
      clearTimeout(sidebarSaveTimer);
      sidebarSaveTimer = null;
      saveSidebarNote();
    }
    sidebar.classList.add('hidden');
    btnSidebar.classList.remove('active');
    document.body.classList.remove('sidebar-open');
  }
}

function loadSidebarNotes() {
  if (!currentPageKey) return;
  try {
    chrome.runtime.sendMessage({ type: 'oc-get-reading', pageKey: currentPageKey }, response => {
      if (response?.reading?.notes) {
        sbNotes.value = response.reading.notes;
      }
    });
  } catch {}
}

function saveSidebarNote() {
  const notes = sbNotes.value.trim();
  if (!currentPageKey) return;
  try {
    chrome.runtime.sendMessage({
      type: 'oc-upsert-reading',
      pageKey: currentPageKey,
      title: toolbarTitle.textContent || currentPageKey,
      url: currentPageKey,
      notes
    }, result => {
      if (result?.ok) {
        sbStatus.textContent = 'Saved';
        sbStatus.className = 'sb-status saved';
        setTimeout(() => {
          if (sbStatus.textContent === 'Saved') {
            sbStatus.textContent = '';
            sbStatus.className = 'sb-status';
          }
        }, 2000);
      }
    });
  } catch {}
}

// Notes auto-save (debounced 1s)
sbNotes.addEventListener('input', () => {
  sbStatus.textContent = '';
  sbStatus.className = 'sb-status';
  clearTimeout(sidebarSaveTimer);
  sidebarSaveTimer = setTimeout(() => saveSidebarNote(), 1000);
});

sbNotes.addEventListener('keydown', (e) => {
  if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    clearTimeout(sidebarSaveTimer);
    saveSidebarNote();
  }
});

function refreshSidebarHighlights() {
  sbHlHeader.textContent = `Highlights (${highlights.length})`;

  if (!highlights.length) {
    sbHlList.innerHTML = '<div class="sb-hl-empty">No highlights yet.</div>';
    return;
  }

  sbHlList.innerHTML = highlights.map(h => `
    <div class="sb-hl-item" data-hl-id="${escAttr(h.id)}">
      <div class="sb-hl-quote">"${escHtml(h.text.length > 120 ? h.text.slice(0, 120) + '\u2026' : h.text)}"</div>
      ${h.comment ? `<div class="sb-hl-comment">\u2014 ${escHtml(h.comment)}</div>` : ''}
    </div>
  `).join('');

  // Click to scroll to highlight in article
  sbHlList.querySelectorAll('.sb-hl-item').forEach(item => {
    item.addEventListener('click', () => {
      const id = item.dataset.hlId;
      const mark = document.querySelector(`mark[data-oc-id="${CSS.escape(id)}"]`);
      if (mark) mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  });
}

// ── Keyboard shortcuts ───────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (highlightMode) exitHighlightMode();
    hideHlToolbar();
    hideAnnPopup();
    hideNoteBubble();
    if (!sidebar.classList.contains('hidden')) toggleSidebar();
  }
});

// ── Utility ──────────────────────────────────────────────────────────
function escHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;');
}

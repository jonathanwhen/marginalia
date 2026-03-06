import { shareAnnotations, getShareUrl } from './lib/supabase.js';

// ── Tab switching ─────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('panel-' + tab.dataset.tab).classList.add('active');
    if (tab.dataset.tab === 'highlights') loadHighlights();
  });
});

document.getElementById('open-settings').addEventListener('click', e => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

document.getElementById('open-dashboard').addEventListener('click', e => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});

document.getElementById('open-library').addEventListener('click', e => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('library.html') });
});

document.getElementById('open-graph').addEventListener('click', e => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('graph.html') });
});

// ── Tag selection ─────────────────────────────────────────────────
function setupTags(containerId) {
  document.querySelectorAll(`#${containerId} .tag-btn`).forEach(btn => {
    btn.addEventListener('click', () => btn.classList.toggle('selected'));
  });
}
setupTags('tags-wrap');

function getSelectedTags(containerId) {
  return [...document.querySelectorAll(`#${containerId} .tag-btn.selected`)]
    .map(b => b.dataset.tag);
}

// Select tags by value (for pre-filling from existing reading)
function selectTags(containerId, tags) {
  document.querySelectorAll(`#${containerId} .tag-btn`).forEach(btn => {
    if (tags.includes(btn.dataset.tag)) btn.classList.add('selected');
    else btn.classList.remove('selected');
  });
}

// ── Toast ─────────────────────────────────────────────────────────
function showToast(msg, type = 'success') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast ${type}`;
  t.style.display = 'block';
  setTimeout(() => { t.style.display = 'none'; }, 2500);
}

// ── Pending count + flush button ──────────────────────────────────
const flushBtn = document.getElementById('oc-flush-btn');

async function updatePendingCount() {
  const { ocReadings = {} } = await chrome.storage.local.get('ocReadings');
  const count = Object.values(ocReadings).filter(r => !r.syncedAt || r.syncedAt < r.updatedAt).length;
  flushBtn.textContent = count > 0 ? `Sync Now (${count})` : 'Sync Now';
  flushBtn.disabled = count === 0;
}

flushBtn.addEventListener('click', async () => {
  flushBtn.disabled = true;
  flushBtn.textContent = 'Syncing...';
  try {
    const result = await chrome.runtime.sendMessage({ type: 'oc-flush' });
    if (result.error) {
      showToast(result.error, 'error');
    } else if (result.failed > 0) {
      const reasons = [];
      if (result.githubOk === false) reasons.push('GitHub failed');
      if (result.telegramOk === false) reasons.push('Telegram failed');
      showToast(`Sync failed: ${reasons.join(', ') || 'unknown'}`, 'error');
    } else if (result.synced > 0) {
      showToast(`Synced ${result.synced} reading${result.synced > 1 ? 's' : ''}`);
    } else {
      showToast('Nothing to sync');
    }
  } catch (e) {
    showToast(`Sync error: ${e.message}`, 'error');
  }
  await updatePendingCount();
  await updateTodayPages();
});

// ── Page key for current tab ────────────────────────────────────────
let currentPageKey = null;
let autofillDone = false; // true once autofill() finishes — enables auto-save on close

// ── Auto-fill from current tab or existing reading ──────────────────
async function autofill() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  currentPageKey = new URL(tab.url).origin + new URL(tab.url).pathname;

  // Detect PDF pages and show "Open in Reader" button
  // Disabled: text layer quality needs improvement before promoting this
  // const isPdf = tab.url.toLowerCase().endsWith('.pdf') ||
  //   /^https:\/\/(www\.)?arxiv\.org\/pdf\//.test(tab.url);
  // if (isPdf) {
  //   const readerBtn = document.getElementById('hl-open-reader');
  //   readerBtn.style.display = 'block';
  //   readerBtn.addEventListener('click', () => {
  //     chrome.tabs.update(tab.id, {
  //       url: chrome.runtime.getURL('reader.html?url=' + encodeURIComponent(tab.url))
  //     });
  //     window.close();
  //   });
  // }

  // Check if a reading already exists for this page
  let reading;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'oc-get-reading', pageKey: currentPageKey });
    reading = response?.reading;
  } catch (e) {
    // Service worker may not be ready yet — continue with no existing reading
  }

  // Estimate pages from word count (used for new readings or backfilling existing ones with 0)
  async function fetchEstPages() {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      const wcResult = await chrome.tabs.sendMessage(tab.id, { type: 'oc-get-word-count' });
      if (wcResult?.wordCount) return Math.max(1, Math.round(wcResult.wordCount / 275));
    } catch (e) {}
    return 0;
  }

  if (reading) {
    // Pre-fill from existing reading
    document.getElementById('log-title').value = reading.title || '';
    document.getElementById('log-author').value = reading.author || '';
    document.getElementById('log-url').value = reading.url || tab.url;
    document.getElementById('log-notes').value = reading.notes || '';
    document.getElementById('log-est-pages').value = reading.estPages || '';
    if (reading.tags?.length) selectTags('tags-wrap', reading.tags);
    document.getElementById('note-input').value = reading.notes || '';
    document.getElementById('log-send').textContent = 'Update Reading';
    document.getElementById('auto-save-hint').style.display = 'block';

    // Backfill page estimate if missing
    if (!reading.estPages) {
      const estPages = await fetchEstPages();
      if (estPages) document.getElementById('log-est-pages').value = estPages;
    }
  } else {
    // Auto-fill from tab metadata
    if (tab.title) document.getElementById('log-title').value = tab.title;
    if (tab.url) document.getElementById('log-url').value = tab.url;

    // Extract author from page meta tags
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          return (
            document.querySelector('meta[name="author"]')?.content ||
            document.querySelector('meta[property="article:author"]')?.content ||
            document.querySelector('[class*="author"] [itemprop="name"]')?.textContent?.trim() ||
            ''
          );
        }
      });
      const author = results?.[0]?.result;
      if (author) document.getElementById('log-author').value = author;
    } catch (e) {}

    // Estimate pages from word count
    const estPages = await fetchEstPages();
    if (estPages) document.getElementById('log-est-pages').value = estPages;
  }

  autofillDone = true;
}

// ── Log / Update reading ────────────────────────────────────────────
document.getElementById('log-send').addEventListener('click', async () => {
  const title = document.getElementById('log-title').value.trim();
  const author = document.getElementById('log-author').value.trim();
  const url = document.getElementById('log-url').value.trim();
  const notes = document.getElementById('log-notes').value.trim();
  const estPages = parseInt(document.getElementById('log-est-pages').value, 10) || 0;
  const tags = getSelectedTags('tags-wrap');

  if (!title) { showToast('Title required', 'error'); return; }
  if (!currentPageKey) { showToast('No page context', 'error'); return; }

  try {
    const result = await chrome.runtime.sendMessage({
      type: 'oc-upsert-reading',
      pageKey: currentPageKey,
      title,
      author,
      url,
      tags,
      notes,
      estPages
    });
    if (result?.ok) {
      showToast(result.created ? 'Reading logged' : 'Reading updated');
      document.getElementById('log-send').textContent = 'Update Reading';
      document.getElementById('auto-save-hint').style.display = 'block';
      // Sync note tab with updated notes
      document.getElementById('note-input').value = notes;
    } else {
      showToast('Failed to save reading', 'error');
    }
  } catch (e) {
    showToast(`Error: ${e.message}`, 'error');
  }
  await updatePendingCount();
  await updateTodayPages();
});

// ── Highlight mode toggle ─────────────────────────────────────────
document.getElementById('hl-mode-btn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    });
    await chrome.scripting.insertCSS({
      target: { tabId: tab.id },
      files: ['content.css']
    });
  } catch (e) {}

  try {
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'oc-toggle-highlight-mode' });
    if (result?.pdf) {
      showToast('PDFs don\u2019t support visual highlighting \u2014 use right-click \u2192 Highlight with Marginalia', 'error');
      return;
    }
  } catch (e) {}

  window.close();
});

// ── Share annotations ─────────────────────────────────────────────
document.getElementById('hl-share-btn').addEventListener('click', async () => {
  if (!currentPageKey) { showToast('No page context', 'error'); return; }

  const btn = document.getElementById('hl-share-btn');
  btn.textContent = 'Sharing...';
  btn.disabled = true;

  try {
    // Gather reading + highlights concurrently
    const [readingRes, hlRes] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'oc-get-reading', pageKey: currentPageKey }),
      chrome.storage.local.get([currentPageKey])
    ]);
    const reading = readingRes?.reading || {};
    const highlights = hlRes[currentPageKey] || [];

    const result = await shareAnnotations({
      pageKey: currentPageKey,
      title: reading.title || document.getElementById('log-title').value.trim(),
      author: reading.author || document.getElementById('log-author').value.trim(),
      url: reading.url || document.getElementById('log-url').value.trim(),
      notes: reading.notes || '',
      tags: reading.tags || [],
      highlights
    });

    const originalUrl = reading.url || document.getElementById('log-url').value.trim();
    const shareUrl = getShareUrl(result.shareCode, originalUrl);
    await navigator.clipboard.writeText(shareUrl);
    showToast(result.updated ? 'Updated — link copied!' : 'Link copied!');
  } catch (e) {
    showToast(e.message || 'Failed to share', 'error');
  }

  btn.textContent = 'Share Annotations';
  btn.disabled = false;
});

// ── Highlights panel (with delete) ────────────────────────────────
async function loadHighlights() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const pageKey = new URL(tab.url).origin + new URL(tab.url).pathname;
  const result = await chrome.storage.local.get([pageKey]);
  const highlights = result[pageKey] || [];
  const list = document.getElementById('hl-list');

  if (!highlights.length) {
    list.innerHTML = '<div class="hl-empty">No highlights on this page yet.<br>Select text to highlight.</div>';
    return;
  }

  list.innerHTML = highlights.map(h => `
    <div class="hl-item" data-hl-id="${escHtml(h.id)}">
      <div class="hl-item-content">
        <div class="hl-quote">"${escHtml(h.text.length > 100 ? h.text.slice(0, 100) + '\u2026' : h.text)}"</div>
        ${h.latex ? `<div class="hl-latex"><code>${escHtml(h.latex)}</code></div>` : ''}
        ${h.comment ? `<div class="hl-comment">${escHtml(h.comment)}</div>` : ''}
      </div>
      <button class="hl-delete" title="Remove highlight">\u00d7</button>
    </div>
  `).join('');

  // Wire up delete buttons
  list.querySelectorAll('.hl-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const item = btn.closest('.hl-item');
      const id = item.dataset.hlId;

      // Remove from storage
      const res = await chrome.storage.local.get([pageKey]);
      const updated = (res[pageKey] || []).filter(h => h.id !== id);
      await chrome.storage.local.set({ [pageKey]: updated });

      // Remove from popup list
      item.remove();
      if (!list.querySelector('.hl-item')) {
        list.innerHTML = '<div class="hl-empty">No highlights on this page yet.<br>Select text to highlight.</div>';
      }

      // Notify background of highlight deletion (marks reading dirty or dequeues standalone)
      try {
        await chrome.runtime.sendMessage({
          type: 'oc-highlight-changed',
          pageKey,
          action: 'delete',
          text: '',
          highlightId: id
        });
      } catch (e) {}
      await updatePendingCount();

      // Tell content script to unwrap the mark from the page DOM
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'oc-delete-highlight', id });
      } catch (e) {}
    });
  });
}

// ── Notes sidebar button ─────────────────────────────────────────
document.getElementById('note-open-sidebar').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] });
    await chrome.tabs.sendMessage(tab.id, { type: 'oc-open-sidebar' });
    window.close();
  } catch (e) {
    // Content script can't run on this page — show fallback inline textarea
    showNoteFallback();
  }
});

function showNoteFallback() {
  document.getElementById('note-sidebar-section').style.display = 'none';
  document.getElementById('note-fallback-section').style.display = 'block';
}

// ── Note fallback (saves to reading, for pages where sidebar can't inject) ──
document.getElementById('note-send').addEventListener('click', async () => {
  const note = document.getElementById('note-input').value.trim();
  if (!note) { showToast('Note is empty', 'error'); return; }
  if (!currentPageKey) { showToast('No page context', 'error'); return; }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const result = await chrome.runtime.sendMessage({
      type: 'oc-upsert-reading',
      pageKey: currentPageKey,
      title: tab?.title || currentPageKey,
      url: tab?.url || currentPageKey,
      notes: note
    });
    if (result?.ok) {
      showToast('Note saved');
      document.getElementById('log-notes').value = note;
      if (result.created) {
        document.getElementById('log-send').textContent = 'Update Reading';
      }
    } else {
      showToast('Failed to save note', 'error');
    }
  } catch (e) {
    showToast(`Error: ${e.message}`, 'error');
  }
  await updatePendingCount();
});

document.getElementById('note-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) document.getElementById('note-send').click();
});

// ── Today's page count ──────────────────────────────────────────────
async function updateTodayPages() {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'oc-get-today-pages' });
    const el = document.getElementById('today-count');
    if (result) {
      el.textContent = `${result.pages}/150 pages today`;
    }
  } catch (e) {}
}

// ── Auto-save Log tab on popup close ──────────────────────────────
// When the popup closes (click outside, tab switch, etc.), auto-save
// the Log form so the user doesn't lose edits or need to press "Update Reading".
function getLogFormData() {
  return {
    title: document.getElementById('log-title').value.trim(),
    author: document.getElementById('log-author').value.trim(),
    url: document.getElementById('log-url').value.trim(),
    notes: document.getElementById('log-notes').value.trim(),
    estPages: parseInt(document.getElementById('log-est-pages').value, 10) || 0,
    tags: getSelectedTags('tags-wrap')
  };
}

window.addEventListener('pagehide', () => {
  if (!autofillDone || !currentPageKey) return;
  const form = getLogFormData();
  if (!form.title) return; // nothing meaningful to save

  // Send undefined for empty fields so upsertReading's ?? operator
  // falls through to existing values instead of overwriting with blanks.
  // This prevents closing the popup from nuking sidebar-saved notes or tags.
  try {
    chrome.runtime.sendMessage({
      type: 'oc-upsert-reading',
      pageKey: currentPageKey,
      title: form.title,
      author: form.author || undefined,
      url: form.url || undefined,
      notes: form.notes || undefined,
      estPages: form.estPages || undefined,
      tags: form.tags.length ? form.tags : undefined
    });
  } catch (e) {}
});

// ── Utility ──────────────────────────────────────────────────────
function escHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ── Init ──────────────────────────────────────────────────────────
autofill().catch(() => {});
updatePendingCount();
updateTodayPages();

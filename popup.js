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

  // Check if this tab is a linked conversation for another reading
  try {
    const resolved = await chrome.runtime.sendMessage({ type: 'oc-resolve-conversation', url: tab.url });
    if (resolved?.pageKey) {
      currentPageKey = resolved.pageKey;
    }
  } catch (e) {}

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
    document.getElementById('log-conversation-url').value = reading.conversationUrl || '';
    document.getElementById('log-est-pages').value = reading.estPages || '';
    if (reading.tags?.length) selectTags('tags-wrap', reading.tags);
    document.getElementById('note-input').value = reading.notes || '';
    document.getElementById('log-send').textContent = 'Update Reading';
    document.getElementById('auto-save-hint').style.display = 'block';
    document.getElementById('log-unlog-btn').style.display = 'block';
    updateStarButton(reading.starred);


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

// ── Star toggle ─────────────────────────────────────────────────────
function updateStarButton(starred) {
  const btn = document.getElementById('log-star-btn');
  btn.innerHTML = starred ? '&#9733;' : '&#9734;';
  btn.style.color = starred ? '#e8a87c' : '#333';
  btn.dataset.starred = starred ? '1' : '0';
}

document.getElementById('log-star-btn').addEventListener('click', async () => {
  if (!currentPageKey) return;
  const result = await chrome.runtime.sendMessage({ type: 'oc-toggle-star', pageKey: currentPageKey });
  if (result?.ok) updateStarButton(result.starred);
});

// ── Log / Update reading ────────────────────────────────────────────
document.getElementById('log-send').addEventListener('click', async () => {
  const title = document.getElementById('log-title').value.trim();
  const author = document.getElementById('log-author').value.trim();
  const url = document.getElementById('log-url').value.trim();
  const notes = document.getElementById('log-notes').value.trim();
  const conversationUrl = document.getElementById('log-conversation-url').value.trim() || null;
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
      conversationUrl,
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

// ── Unlog reading ────────────────────────────────────────────────
const unlogBtn = document.getElementById('log-unlog-btn');
let unlogConfirm = false;
unlogBtn.addEventListener('click', async () => {
  if (!currentPageKey) return;
  if (!unlogConfirm) {
    unlogBtn.textContent = 'Click again to confirm';
    unlogBtn.style.borderColor = '#eb5757';
    unlogBtn.style.color = '#eb5757';
    unlogConfirm = true;
    setTimeout(() => {
      unlogBtn.textContent = 'Unlog Reading';
      unlogBtn.style.borderColor = '#333';
      unlogBtn.style.color = '#888';
      unlogConfirm = false;
    }, 3000);
    return;
  }
  const result = await chrome.runtime.sendMessage({ type: 'oc-delete-reading', pageKey: currentPageKey });
  if (result?.ok) {
    showToast('Reading removed');
    document.getElementById('log-send').textContent = 'Log Reading';
    document.getElementById('auto-save-hint').style.display = 'none';
    unlogBtn.style.display = 'none';
    unlogConfirm = false;
  } else {
    showToast('Failed to remove', 'error');
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
        ${h.latex ? `<div class="hl-latex">${renderLatex(h.latex)}</div>` : ''}
        ${h.comment ? `<div class="hl-comment">${renderMathInText(h.comment)}</div>` : ''}
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
    conversationUrl: document.getElementById('log-conversation-url').value.trim() || null,
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
      conversationUrl: form.conversationUrl || undefined,
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

// Render a raw LaTeX string (from h.latex) as formatted HTML via KaTeX.
function renderLatex(tex) {
  if (!tex || typeof katex === 'undefined') return `<code>${escHtml(tex)}</code>`;
  try {
    return katex.renderToString(tex, { throwOnError: false, displayMode: false });
  } catch {
    return `<code>${escHtml(tex)}</code>`;
  }
}

// Process text containing inline $...$ or display $$...$$ math and render via KaTeX.
function renderMathInText(text) {
  if (!text || typeof katex === 'undefined') return escHtml(text);
  let result = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '$' && text[i + 1] === '$') {
      const end = text.indexOf('$$', i + 2);
      if (end !== -1) {
        const tex = text.slice(i + 2, end);
        try { result += katex.renderToString(tex, { throwOnError: false, displayMode: true }); }
        catch { result += '$$' + escHtml(tex) + '$$'; }
        i = end + 2;
        continue;
      }
    }
    if (text[i] === '$' && (i === 0 || text[i - 1] !== '$')) {
      const end = text.indexOf('$', i + 1);
      if (end !== -1 && !text.slice(i + 1, end).includes('\n')) {
        const tex = text.slice(i + 1, end);
        try { result += katex.renderToString(tex, { throwOnError: false, displayMode: false }); }
        catch { result += '$' + escHtml(tex) + '$'; }
        i = end + 1;
        continue;
      }
    }
    result += escHtml(text[i]);
    i++;
  }
  return result;
}

// ── Collaborative annotations UI ──────────────────────────────────
document.getElementById('collab-btn')?.addEventListener('click', () => {
  const panel = document.getElementById('collab-panel');
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  if (panel.style.display === 'block') checkCollabStatus();
});

async function checkCollabStatus() {
  if (!currentPageKey) return;
  const statusEl = document.getElementById('collab-status');
  const joinSection = document.getElementById('collab-join-section');
  const activeSection = document.getElementById('collab-active-section');

  statusEl.textContent = 'Checking...';

  try {
    const result = await chrome.runtime.sendMessage({ type: 'oc-collab-status', pageKey: currentPageKey });
    if (result && result.collabPageId) {
      // Collab is active for this page
      statusEl.textContent = result.isOwner ? 'You created this collab.' : 'You joined this collab.';
      joinSection.style.display = 'none';
      activeSection.style.display = 'block';
      document.getElementById('collab-invite-display').textContent = 'Invite code: ' + result.inviteCode;

      document.getElementById('collab-copy-btn').onclick = async () => {
        await navigator.clipboard.writeText(result.inviteCode);
        showToast('Invite code copied!');
      };
    } else {
      statusEl.textContent = 'No collaboration on this page yet.';
      joinSection.style.display = 'block';
      activeSection.style.display = 'none';
    }
  } catch (e) {
    statusEl.textContent = 'Sign in to collaborate.';
    joinSection.style.display = 'none';
    activeSection.style.display = 'none';
  }
}

document.getElementById('collab-create-btn')?.addEventListener('click', async () => {
  if (!currentPageKey) { showToast('No page context', 'error'); return; }
  const btn = document.getElementById('collab-create-btn');
  btn.textContent = 'Creating...';
  btn.disabled = true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const result = await chrome.runtime.sendMessage({
      type: 'oc-collab-create',
      pageKey: currentPageKey,
      pageUrl: tab?.url || '',
      pageTitle: tab?.title || currentPageKey
    });

    if (result?.error) {
      showToast(result.error, 'error');
    } else if (result?.inviteCode) {
      await navigator.clipboard.writeText(result.inviteCode);
      showToast('Collab created! Invite code copied.');
      checkCollabStatus();
    }
  } catch (e) {
    showToast(e.message || 'Failed to create collab', 'error');
  }

  btn.textContent = 'Create Collab';
  btn.disabled = false;
});

document.getElementById('collab-join-btn')?.addEventListener('click', async () => {
  const input = document.getElementById('collab-invite-input');
  const code = input.value.trim();
  if (!code) { showToast('Enter an invite code', 'error'); return; }

  const btn = document.getElementById('collab-join-btn');
  btn.textContent = 'Joining...';
  btn.disabled = true;

  try {
    const result = await chrome.runtime.sendMessage({
      type: 'oc-collab-join',
      inviteCode: code
    });

    if (result?.error) {
      showToast(result.error, 'error');
    } else if (result?.collabPageId) {
      showToast('Joined! Highlights will sync.');
      input.value = '';
      checkCollabStatus();
    }
  } catch (e) {
    showToast(e.message || 'Failed to join', 'error');
  }

  btn.textContent = 'Join';
  btn.disabled = false;
});

// ── Init ──────────────────────────────────────────────────────────
autofill().catch(() => {});
updatePendingCount();
updateTodayPages();

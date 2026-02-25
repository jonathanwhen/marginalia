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
  // Count dirty readings + standalone outbox items
  const { ocReadings = {}, ocOutbox = [] } = await chrome.storage.local.get(['ocReadings', 'ocOutbox']);
  const dirtyCount = Object.values(ocReadings).filter(r => r.dirty).length;
  const count = dirtyCount + ocOutbox.length;
  flushBtn.textContent = count > 0 ? `Send Now (${count})` : 'Send Now';
  flushBtn.disabled = count === 0;
}

flushBtn.addEventListener('click', async () => {
  flushBtn.disabled = true;
  flushBtn.textContent = 'Sending...';
  try {
    const result = await chrome.runtime.sendMessage({ type: 'oc-flush' });
    if (result.error) {
      showToast(result.error, 'error');
    } else if (result.failed > 0) {
      showToast(`Sent ${result.sent}, failed ${result.failed}`, 'error');
    } else if (result.sent > 0) {
      showToast(`Sent ${result.sent} item${result.sent > 1 ? 's' : ''}`);
    } else {
      showToast('Nothing to send');
    }
  } catch (e) {
    showToast(`Flush error: ${e.message}`, 'error');
  }
  await updatePendingCount();
  await updateTodayPages();
});

// ── Page key for current tab ────────────────────────────────────────
let currentPageKey = null;

// ── Auto-fill from current tab or existing reading ──────────────────
async function autofill() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  currentPageKey = new URL(tab.url).origin + new URL(tab.url).pathname;

  // Check if a reading already exists for this page
  const response = await chrome.runtime.sendMessage({ type: 'oc-get-reading', pageKey: currentPageKey });
  const reading = response?.reading;

  if (reading) {
    // Pre-fill from existing reading
    document.getElementById('log-title').value = reading.title || '';
    document.getElementById('log-author').value = reading.author || '';
    document.getElementById('log-url').value = reading.url || tab.url;
    document.getElementById('log-notes').value = reading.notes || '';
    document.getElementById('log-est-pages').value = reading.estPages || '';
    if (reading.tags?.length) selectTags('tags-wrap', reading.tags);
    // Pre-fill note tab with existing notes
    document.getElementById('note-input').value = reading.notes || '';
    // Change button text to indicate update
    document.getElementById('log-send').textContent = 'Update Reading';
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
    try {
      // Ensure content script is injected
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      });
      const wcResult = await chrome.tabs.sendMessage(tab.id, { type: 'oc-get-word-count' });
      if (wcResult?.wordCount) {
        const estPages = Math.round(wcResult.wordCount / 275);
        document.getElementById('log-est-pages').value = estPages > 0 ? estPages : 1;
      }
    } catch (e) {}
  }
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
    await chrome.tabs.sendMessage(tab.id, { type: 'oc-toggle-highlight-mode' });
  } catch (e) {}

  window.close();
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
    <div class="hl-item" data-hl-id="${h.id}">
      <div class="hl-item-content">
        <div class="hl-quote">"${h.text.length > 100 ? h.text.slice(0, 100) + '\u2026' : h.text}"</div>
        ${h.comment ? `<div class="hl-comment">${h.comment}</div>` : ''}
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

// ── Note (saves to reading) ──────────────────────────────────────
document.getElementById('note-send').addEventListener('click', async () => {
  const note = document.getElementById('note-input').value.trim();
  if (!note) { showToast('Note is empty', 'error'); return; }
  if (!currentPageKey) { showToast('No page context', 'error'); return; }

  try {
    // Upsert reading with just the note (auto-creates minimal reading if none exists)
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
      // Sync log tab notes field
      document.getElementById('log-notes').value = note;
      // If this created a new reading, update the log button
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

// ── Init ──────────────────────────────────────────────────────────
autofill();
updatePendingCount();
updateTodayPages();

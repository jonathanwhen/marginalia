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

// ── Tag selection ─────────────────────────────────────────────────
function setupTags(containerId) {
  document.querySelectorAll(`#${containerId} .tag-btn`).forEach(btn => {
    btn.addEventListener('click', () => btn.classList.toggle('selected'));
  });
}
setupTags('tags-wrap');
setupTags('note-tags-wrap');

function getSelectedTags(containerId) {
  return [...document.querySelectorAll(`#${containerId} .tag-btn.selected`)]
    .map(b => b.dataset.tag);
}

// ── Toast ─────────────────────────────────────────────────────────
function showToast(msg, type = 'success') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast ${type}`;
  t.style.display = 'block';
  setTimeout(() => { t.style.display = 'none'; }, 2500);
}

// ── Enqueue via background ────────────────────────────────────────
async function enqueueMessage(text) {
  try {
    await chrome.runtime.sendMessage({ type: 'oc-enqueue', text });
    await updatePendingCount();
    return true;
  } catch (e) {
    showToast(`Queue error: ${e.message}`, 'error');
    return false;
  }
}

// ── Pending count + flush button ──────────────────────────────────
const flushBtn = document.getElementById('oc-flush-btn');

async function updatePendingCount() {
  const { ocOutbox = [] } = await chrome.storage.local.get('ocOutbox');
  const count = ocOutbox.length;
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
});

// ── Auto-fill from current tab ────────────────────────────────────
async function autofill() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  if (tab.title) document.getElementById('log-title').value = tab.title;
  if (tab.url) document.getElementById('log-url').value = tab.url;

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
}

// ── Log reading ───────────────────────────────────────────────────
document.getElementById('log-send').addEventListener('click', async () => {
  const title = document.getElementById('log-title').value.trim();
  const author = document.getElementById('log-author').value.trim();
  const url = document.getElementById('log-url').value.trim();
  const notes = document.getElementById('log-notes').value.trim();
  const tags = getSelectedTags('tags-wrap');

  if (!title) { showToast('Title required', 'error'); return; }

  // Save to local log
  const { readingLog = [] } = await chrome.storage.local.get('readingLog');
  readingLog.push({ title, author, url, notes, tags, timestamp: new Date().toISOString() });
  await chrome.storage.local.set({ readingLog });

  // Format and enqueue
  let msg = `reading: ${title}`;
  if (author) msg += ` by ${author}`;
  if (tags.length) msg += `\ntags: ${tags.join(', ')}`;
  if (url) msg += `\nurl: ${url}`;
  if (notes) msg += `\nnotes: ${notes}`;

  const ok = await enqueueMessage(msg);
  if (ok) {
    showToast('Queued');
    document.getElementById('log-notes').value = '';
    document.querySelectorAll('#tags-wrap .tag-btn').forEach(b => b.classList.remove('selected'));
  }
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

      // Remove queued outbox messages for this highlight
      try {
        await chrome.runtime.sendMessage({ type: 'oc-dequeue-highlight', highlightId: id });
      } catch (e) {}
      await updatePendingCount();

      // Tell content script to unwrap the mark from the page DOM
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'oc-delete-highlight', id });
      } catch (e) {}
    });
  });
}

// ── Note ──────────────────────────────────────────────────────────
document.getElementById('note-send').addEventListener('click', async () => {
  const note = document.getElementById('note-input').value.trim();
  const tags = getSelectedTags('note-tags-wrap');
  if (!note) return;
  let msg = `note: ${note}`;
  if (tags.length) msg += `\ntags: ${tags.join(', ')}`;
  const ok = await enqueueMessage(msg);
  if (ok) {
    showToast('Queued');
    document.getElementById('note-input').value = '';
    document.querySelectorAll('#note-tags-wrap .tag-btn').forEach(b => b.classList.remove('selected'));
  } else {
    showToast('Failed to queue', 'error');
  }
});

document.getElementById('note-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) document.getElementById('note-send').click();
});

// ── Init ──────────────────────────────────────────────────────────
autofill();
updatePendingCount();

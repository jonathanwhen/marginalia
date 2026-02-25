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

// ── Telegram send ─────────────────────────────────────────────────
async function sendMessage(text) {
  const { botToken, chatId } = await chrome.storage.sync.get(['botToken', 'chatId']);
  if (!botToken || !chatId) { showToast('Configure settings first', 'error'); return false; }
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const desc = body.description || `HTTP ${res.status}`;
      showToast(`Telegram: ${desc}`, 'error');
      return false;
    }
    return true;
  } catch (e) {
    showToast(`Network error: ${e.message}`, 'error');
    return false;
  }
}

// ── Auto-fill from current tab ────────────────────────────────────
async function autofill() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  if (tab.title) document.getElementById('log-title').value = tab.title;
  if (tab.url) document.getElementById('log-url').value = tab.url;

  // Try to get author from page meta
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

  // Format Telegram message
  let msg = `reading: ${title}`;
  if (author) msg += ` by ${author}`;
  if (tags.length) msg += `\ntags: ${tags.join(', ')}`;
  if (url) msg += `\nurl: ${url}`;
  if (notes) msg += `\nnotes: ${notes}`;

  const ok = await sendMessage(msg);
  if (ok) {
    showToast('Logged ✓');
    document.getElementById('log-notes').value = '';
    document.querySelectorAll('#tags-wrap .tag-btn').forEach(b => b.classList.remove('selected'));
  }
});

// ── Highlight mode toggle ─────────────────────────────────────────
document.getElementById('hl-mode-btn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  // Ensure content script + CSS are injected (no-op if already loaded due to guard)
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    });
    await chrome.scripting.insertCSS({
      target: { tabId: tab.id },
      files: ['content.css']
    });
  } catch (e) {
    // Can't inject on chrome:// or other restricted pages
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'oc-toggle-highlight-mode' });
  } catch (e) {
    // Content script still unreachable — restricted page
  }

  window.close();
});

// ── Highlights panel ──────────────────────────────────────────────
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
    <div class="hl-item">
      <div class="hl-quote">"${h.text.length > 100 ? h.text.slice(0, 100) + '…' : h.text}"</div>
      ${h.comment ? `<div class="hl-comment">${h.comment}</div>` : ''}
    </div>
  `).join('');
}

// ── Note ──────────────────────────────────────────────────────────
document.getElementById('note-send').addEventListener('click', async () => {
  const note = document.getElementById('note-input').value.trim();
  const tags = getSelectedTags('note-tags-wrap');
  if (!note) return;
  let msg = `note: ${note}`;
  if (tags.length) msg += `\ntags: ${tags.join(', ')}`;
  const ok = await sendMessage(msg);
  if (ok) {
    showToast('Note sent ✓');
    document.getElementById('note-input').value = '';
    document.querySelectorAll('#note-tags-wrap .tag-btn').forEach(b => b.classList.remove('selected'));
  } else {
    showToast('Failed to send', 'error');
  }
});

document.getElementById('note-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) document.getElementById('note-send').click();
});

// ── Init ──────────────────────────────────────────────────────────
autofill();

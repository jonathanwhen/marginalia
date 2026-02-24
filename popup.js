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
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  });
  return res.ok;
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

// ── Today's page count ────────────────────────────────────────────
async function loadTodayCount() {
  const today = new Date().toISOString().slice(0, 10);
  const { readingLog = [] } = await chrome.storage.local.get('readingLog');
  const todayPages = readingLog
    .filter(e => e.timestamp.startsWith(today))
    .reduce((sum, e) => sum + (e.pages || 0), 0);
  document.getElementById('today-count').textContent = `Today: ${todayPages} pg`;
}

// ── Log reading ───────────────────────────────────────────────────
document.getElementById('log-send').addEventListener('click', async () => {
  const title = document.getElementById('log-title').value.trim();
  const pages = parseInt(document.getElementById('log-pages').value);
  const author = document.getElementById('log-author').value.trim();
  const url = document.getElementById('log-url').value.trim();
  const notes = document.getElementById('log-notes').value.trim();
  const tags = getSelectedTags('tags-wrap');

  if (!title || !pages) { showToast('Title and pages required', 'error'); return; }

  // Save to local log
  const { readingLog = [] } = await chrome.storage.local.get('readingLog');
  readingLog.push({ title, author, pages, url, notes, tags, timestamp: new Date().toISOString() });
  await chrome.storage.local.set({ readingLog });

  // Format Telegram message
  let msg = `reading: ${pages} pages — ${title}`;
  if (author) msg += ` by ${author}`;
  if (tags.length) msg += `\ntags: ${tags.join(', ')}`;
  if (url) msg += `\nurl: ${url}`;
  if (notes) msg += `\nnotes: ${notes}`;

  const ok = await sendMessage(msg);
  if (ok) {
    showToast('Logged ✓');
    document.getElementById('log-pages').value = '';
    document.getElementById('log-notes').value = '';
    document.querySelectorAll('#tags-wrap .tag-btn').forEach(b => b.classList.remove('selected'));
    loadTodayCount();
  } else {
    showToast('Failed to send', 'error');
  }
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
loadTodayCount();

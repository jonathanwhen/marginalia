(() => {
  let toolbar = null;
  let commentBox = null;
  let noteBubble = null;
  let pendingRange = null;
  let pendingText = null;

  const pageKey = () => location.origin + location.pathname;

  // ── Storage helpers ──────────────────────────────────────────────
  function getHighlights(cb) {
    chrome.storage.local.get([pageKey()], res => cb(res[pageKey()] || []));
  }
  function saveHighlights(arr, cb) {
    chrome.storage.local.set({ [pageKey()]: arr }, cb);
  }

  // ── Re-apply stored highlights on load ───────────────────────────
  function applyStoredHighlights() {
    getHighlights(highlights => {
      highlights.forEach(h => injectHighlight(h));
    });
  }

  function injectHighlight(h) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
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
      mark.addEventListener('click', e => {
        e.stopPropagation();
        showNoteBubble(mark, h);
      });
    } catch (e) {}
  }

  // ── Toolbar ──────────────────────────────────────────────────────
  function removeToolbar() {
    if (toolbar) { toolbar.remove(); toolbar = null; }
  }
  function removeCommentBox() {
    if (commentBox) { commentBox.remove(); commentBox = null; }
  }
  function removeNoteBubble() {
    if (noteBubble) { noteBubble.remove(); noteBubble = null; }
  }

  function showToolbar(x, y, text, range) {
    removeToolbar();
    pendingText = text;
    pendingRange = range.cloneRange();

    toolbar = document.createElement('div');
    toolbar.id = 'oc-toolbar';
    toolbar.innerHTML = `
      <span>🦞</span>
      <button id="oc-btn-highlight">Highlight</button>
      <div class="oc-divider"></div>
      <button id="oc-btn-comment">+ Comment</button>
    `;
    document.body.appendChild(toolbar);

    // Position near selection
    const vw = window.innerWidth, vh = window.innerHeight;
    let tx = x - toolbar.offsetWidth / 2;
    let ty = y - 48;
    tx = Math.max(8, Math.min(tx, vw - toolbar.offsetWidth - 8));
    ty = Math.max(8, ty);
    toolbar.style.left = tx + 'px';
    toolbar.style.top = ty + 'px';

    toolbar.querySelector('#oc-btn-highlight').addEventListener('click', e => {
      e.stopPropagation();
      saveHighlight(pendingText, pendingRange, '');
      removeToolbar();
    });
    toolbar.querySelector('#oc-btn-comment').addEventListener('click', e => {
      e.stopPropagation();
      removeToolbar();
      showCommentBox(x, y);
    });
  }

  function showCommentBox(x, y) {
    removeCommentBox();
    commentBox = document.createElement('div');
    commentBox.id = 'oc-comment-box';
    commentBox.innerHTML = `
      <div style="font-size:11px;color:#666;margin-bottom:6px;font-family:-apple-system,sans-serif;">Add a comment</div>
      <textarea placeholder="Your thought on this..."></textarea>
      <div class="oc-cb-actions">
        <button class="oc-save">Save</button>
        <button class="oc-cancel">Cancel</button>
      </div>
    `;
    document.body.appendChild(commentBox);

    const vw = window.innerWidth;
    let cx = x - 140;
    cx = Math.max(8, Math.min(cx, vw - 290));
    commentBox.style.left = cx + 'px';
    commentBox.style.top = (y + 10) + 'px';

    const ta = commentBox.querySelector('textarea');
    ta.focus();

    commentBox.querySelector('.oc-save').addEventListener('click', () => {
      saveHighlight(pendingText, pendingRange, ta.value.trim());
      removeCommentBox();
    });
    commentBox.querySelector('.oc-cancel').addEventListener('click', removeCommentBox);
    ta.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commentBox.querySelector('.oc-save').click();
      if (e.key === 'Escape') removeCommentBox();
    });
  }

  function showNoteBubble(anchor, h) {
    removeNoteBubble();
    noteBubble = document.createElement('div');
    noteBubble.id = 'oc-note-bubble';
    noteBubble.innerHTML = `
      <div class="oc-nb-quote">${h.text.length > 120 ? h.text.slice(0, 120) + '…' : h.text}</div>
      ${h.comment ? `<div class="oc-nb-comment">${h.comment}</div>` : ''}
      <span class="oc-nb-delete">✕ Remove highlight</span>
    `;
    document.body.appendChild(noteBubble);

    const rect = anchor.getBoundingClientRect();
    let nx = rect.left + window.scrollX;
    let ny = rect.bottom + window.scrollY + 8;
    const vw = window.innerWidth;
    nx = Math.max(8, Math.min(nx, vw - 270));
    noteBubble.style.left = nx + 'px';
    noteBubble.style.top = ny + 'px';

    noteBubble.querySelector('.oc-nb-delete').addEventListener('click', () => {
      deleteHighlight(h.id, anchor);
      removeNoteBubble();
    });
  }

  function saveHighlight(text, range, comment) {
    const h = {
      id: Date.now().toString(),
      text,
      comment,
      timestamp: new Date().toISOString()
    };
    getHighlights(highlights => {
      highlights.push(h);
      saveHighlights(highlights, () => {
        wrapRange(range, h);
        window.getSelection()?.removeAllRanges();
        // Notify via Telegram
        sendToTelegram(
          `highlight: "${text.slice(0, 200)}"${comment ? `\ncomment: ${comment}` : ''}\nsource: ${location.href}`
        );
      });
    });
  }

  function deleteHighlight(id, markEl) {
    // Unwrap the mark element
    const parent = markEl.parentNode;
    while (markEl.firstChild) parent.insertBefore(markEl.firstChild, markEl);
    parent.removeChild(markEl);
    // Remove from storage
    getHighlights(highlights => {
      saveHighlights(highlights.filter(h => h.id !== id));
    });
  }

  // ── Telegram sender ──────────────────────────────────────────────
  async function sendToTelegram(text) {
    chrome.storage.sync.get(['botToken', 'chatId'], ({ botToken, chatId }) => {
      if (!botToken || !chatId) return;
      fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text })
      });
    });
  }

  // ── Selection listener ───────────────────────────────────────────
  document.addEventListener('mouseup', e => {
    if (toolbar && toolbar.contains(e.target)) return;
    if (commentBox && commentBox.contains(e.target)) return;
    removeNoteBubble();

    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel?.toString().trim();
      if (!text || text.length < 5) { removeToolbar(); return; }
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      showToolbar(
        rect.left + rect.width / 2 + window.scrollX,
        rect.top + window.scrollY,
        text,
        range
      );
    }, 10);
  });

  document.addEventListener('mousedown', e => {
    if (toolbar && !toolbar.contains(e.target)) removeToolbar();
    if (commentBox && !commentBox.contains(e.target)) removeCommentBox();
    if (noteBubble && !noteBubble.contains(e.target)) removeNoteBubble();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { removeToolbar(); removeCommentBox(); removeNoteBubble(); }
  });

  // Apply on load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyStoredHighlights);
  } else {
    applyStoredHighlights();
  }
})();

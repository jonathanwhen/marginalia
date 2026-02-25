(() => {
  // Guard against double-injection (manifest auto-inject + programmatic inject)
  if (window.__ocContentScriptLoaded) return;
  window.__ocContentScriptLoaded = true;

  let toolbar = null;
  let commentBox = null;
  let noteBubble = null;
  let annotationPopup = null;
  let pendingRange = null;
  let pendingText = null;
  let highlightMode = false;
  let modeBanner = null;

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

  // Returns the created <mark> element (or null on failure)
  function wrapRange(range, h) {
    try {
      const mark = document.createElement('mark');
      mark.className = 'oc-highlight' + (h.comment ? ' oc-highlight-comment' : '');
      mark.dataset.ocId = h.id;
      mark.title = h.comment || '';
      range.surroundContents(mark);
      mark.addEventListener('click', e => {
        e.stopPropagation();
        if (!highlightMode) showNoteBubble(mark, h);
      });
      return mark;
    } catch (e) {
      return null;
    }
  }

  // ── Highlight mode ─────────────────────────────────────────────
  function enterHighlightMode() {
    if (highlightMode) return;
    highlightMode = true;
    removeToolbar();
    removeCommentBox();
    removeNoteBubble();
    removeAnnotationPopup();

    modeBanner = document.createElement('div');
    modeBanner.id = 'oc-mode-banner';
    modeBanner.innerHTML = `
      <span class="oc-banner-icon">🦞</span>
      <span class="oc-banner-text">Highlight mode — select text to highlight</span>
      <button id="oc-banner-exit">✕ Done</button>
    `;
    document.body.appendChild(modeBanner);

    modeBanner.querySelector('#oc-banner-exit').addEventListener('click', exitHighlightMode);
  }

  function exitHighlightMode() {
    highlightMode = false;
    if (modeBanner) { modeBanner.remove(); modeBanner = null; }
    removeAnnotationPopup();
    window.getSelection()?.removeAllRanges();
  }

  // Listen for toggle message from popup
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'oc-toggle-highlight-mode') {
      if (highlightMode) exitHighlightMode();
      else enterHighlightMode();
      sendResponse({ ok: true });
    }
  });

  // ── Remove helpers ─────────────────────────────────────────────
  function removeToolbar() {
    if (toolbar) { toolbar.remove(); toolbar = null; }
  }
  function removeCommentBox() {
    if (commentBox) { commentBox.remove(); commentBox = null; }
  }
  function removeNoteBubble() {
    if (noteBubble) { noteBubble.remove(); noteBubble = null; }
  }
  function removeAnnotationPopup() {
    if (annotationPopup) { annotationPopup.remove(); annotationPopup = null; }
  }

  // ── Annotation popup (appears after highlight-mode auto-highlight) ──
  function showAnnotationPopup(mark, h) {
    removeAnnotationPopup();
    annotationPopup = document.createElement('div');
    annotationPopup.id = 'oc-annotation-popup';
    annotationPopup.innerHTML = `
      <input type="text" placeholder="Add a note... (Enter to save, Esc to skip)" class="oc-ann-input" />
    `;
    document.body.appendChild(annotationPopup);

    const rect = mark.getBoundingClientRect();
    const vw = window.innerWidth;
    let px = rect.left + window.scrollX;
    px = Math.max(8, Math.min(px, vw - 270));
    annotationPopup.style.left = px + 'px';
    annotationPopup.style.top = (rect.bottom + window.scrollY + 4) + 'px';

    const input = annotationPopup.querySelector('.oc-ann-input');
    input.focus();

    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const comment = input.value.trim();
        if (comment) updateHighlightComment(h.id, comment, mark, h);
        removeAnnotationPopup();
      }
      if (e.key === 'Escape') removeAnnotationPopup();
    });

    // Prevent mousedown on the popup from dismissing it or starting selection
    annotationPopup.addEventListener('mousedown', e => e.stopPropagation());
  }

  // ── Update a highlight's comment in storage + DOM ──────────────
  function updateHighlightComment(id, comment, mark, h) {
    h.comment = comment;
    mark.className = 'oc-highlight' + (comment ? ' oc-highlight-comment' : '');
    mark.title = comment;
    getHighlights(highlights => {
      const existing = highlights.find(hl => hl.id === id);
      if (existing) existing.comment = comment;
      saveHighlights(highlights);
    });
    sendToTelegram(
      `annotation: "${comment}"\non: "${h.text.slice(0, 100)}"\nsource: ${location.href}`
    );
  }

  // ── Toolbar (used outside highlight mode) ──────────────────────
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

    const vw = window.innerWidth;
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

  // ── Note bubble (click existing highlight to view/edit/delete) ─
  function showNoteBubble(anchor, h) {
    removeNoteBubble();
    const hasComment = !!h.comment;
    noteBubble = document.createElement('div');
    noteBubble.id = 'oc-note-bubble';
    noteBubble.innerHTML = `
      <div class="oc-nb-quote">${h.text.length > 120 ? h.text.slice(0, 120) + '…' : h.text}</div>
      ${hasComment ? `<div class="oc-nb-comment">${h.comment}</div>` : ''}
      <div class="oc-nb-edit-section" style="display:none;">
        <textarea class="oc-nb-edit-input" placeholder="Add a note...">${h.comment || ''}</textarea>
        <div class="oc-nb-edit-actions">
          <button class="oc-nb-edit-save">Save</button>
          <button class="oc-nb-edit-cancel">Cancel</button>
        </div>
      </div>
      <div class="oc-nb-actions">
        <span class="oc-nb-edit-btn">${hasComment ? '✎ Edit note' : '✎ Add note'}</span>
        <span class="oc-nb-delete">✕ Remove</span>
      </div>
    `;
    document.body.appendChild(noteBubble);

    const rect = anchor.getBoundingClientRect();
    let nx = rect.left + window.scrollX;
    let ny = rect.bottom + window.scrollY + 8;
    const vw = window.innerWidth;
    nx = Math.max(8, Math.min(nx, vw - 270));
    noteBubble.style.left = nx + 'px';
    noteBubble.style.top = ny + 'px';

    // Delete handler
    noteBubble.querySelector('.oc-nb-delete').addEventListener('click', () => {
      deleteHighlight(h.id, anchor);
      removeNoteBubble();
    });

    // Edit/add note handler
    const editSection = noteBubble.querySelector('.oc-nb-edit-section');
    const editInput = noteBubble.querySelector('.oc-nb-edit-input');
    const commentDiv = noteBubble.querySelector('.oc-nb-comment');
    const actionsDiv = noteBubble.querySelector('.oc-nb-actions');

    noteBubble.querySelector('.oc-nb-edit-btn').addEventListener('click', () => {
      editSection.style.display = 'block';
      actionsDiv.style.display = 'none';
      if (commentDiv) commentDiv.style.display = 'none';
      editInput.focus();
      editInput.setSelectionRange(editInput.value.length, editInput.value.length);
    });

    noteBubble.querySelector('.oc-nb-edit-save').addEventListener('click', () => {
      const newComment = editInput.value.trim();
      updateHighlightComment(h.id, newComment, anchor, h);
      removeNoteBubble();
    });

    noteBubble.querySelector('.oc-nb-edit-cancel').addEventListener('click', () => {
      editSection.style.display = 'none';
      actionsDiv.style.display = '';
      if (commentDiv) commentDiv.style.display = '';
    });

    editInput.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        noteBubble.querySelector('.oc-nb-edit-save').click();
      }
      if (e.key === 'Escape') {
        noteBubble.querySelector('.oc-nb-edit-cancel').click();
      }
    });
  }

  // ── Save / delete highlights ───────────────────────────────────
  function saveHighlight(text, range, comment, onDone) {
    const h = {
      id: Date.now().toString(),
      text,
      comment,
      timestamp: new Date().toISOString()
    };
    getHighlights(highlights => {
      highlights.push(h);
      saveHighlights(highlights, () => {
        const mark = wrapRange(range, h);
        window.getSelection()?.removeAllRanges();
        sendToTelegram(
          `highlight: "${text.slice(0, 200)}"${comment ? `\ncomment: ${comment}` : ''}\nsource: ${location.href}`
        );
        if (onDone) onDone(h, mark);
      });
    });
  }

  function deleteHighlight(id, markEl) {
    const parent = markEl.parentNode;
    while (markEl.firstChild) parent.insertBefore(markEl.firstChild, markEl);
    parent.removeChild(markEl);
    parent.normalize();
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
    if (modeBanner && modeBanner.contains(e.target)) return;
    if (noteBubble && noteBubble.contains(e.target)) return;
    if (annotationPopup && annotationPopup.contains(e.target)) return;

    removeNoteBubble();

    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel?.toString().trim();
      if (!text || text.length < 2) {
        if (!highlightMode) removeToolbar();
        return;
      }

      const range = sel.getRangeAt(0);

      if (highlightMode) {
        removeAnnotationPopup();
        saveHighlight(text, range.cloneRange(), '', (h, mark) => {
          if (mark) showAnnotationPopup(mark, h);
        });
      } else {
        const rect = range.getBoundingClientRect();
        showToolbar(
          rect.left + rect.width / 2 + window.scrollX,
          rect.top + window.scrollY,
          text,
          range
        );
      }
    }, 10);
  });

  document.addEventListener('mousedown', e => {
    if (toolbar && !toolbar.contains(e.target)) removeToolbar();
    if (commentBox && !commentBox.contains(e.target)) removeCommentBox();
    if (noteBubble && !noteBubble.contains(e.target)) removeNoteBubble();
    if (annotationPopup && !annotationPopup.contains(e.target)) removeAnnotationPopup();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (highlightMode) exitHighlightMode();
      removeToolbar();
      removeCommentBox();
      removeNoteBubble();
      removeAnnotationPopup();
    }
  });

  // Apply on load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyStoredHighlights);
  } else {
    applyStoredHighlights();
  }
})();

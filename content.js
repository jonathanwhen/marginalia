(() => {
  // Guard against double-injection (manifest auto-inject + programmatic inject)
  if (window.__ocContentScriptLoaded) return;
  window.__ocContentScriptLoaded = true;

  let toolbar = null;
  let noteBubble = null;
  let annotationPopup = null;
  let pendingRange = null;
  let pendingText = null;
  let highlightMode = false;
  let modeBanner = null;

  const pageKey = () => location.origin + location.pathname;

  // ── Storage helpers ──────────────────────────────────────────────
  function isContextValid() {
    try { return !!chrome.runtime?.id; } catch { return false; }
  }

  function getHighlights(cb) {
    if (!isContextValid()) { cb([]); return; }
    try {
      chrome.storage.local.get([pageKey()], res => {
        if (!isContextValid()) { cb([]); return; }
        cb(res[pageKey()] || []);
      });
    } catch (e) {
      cb([]);
    }
  }
  function saveHighlights(arr, cb) {
    if (!isContextValid()) { if (cb) cb(); return; }
    try {
      chrome.storage.local.set({ [pageKey()]: arr }, () => {
        if (cb) cb();
      });
    } catch (e) {
      if (cb) cb();
    }
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

  // Returns the first created <mark> element (or null on failure)
  function wrapRange(range, h) {
    // Try simple surroundContents first (works when selection is within one element)
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
      // Cross-element selection — wrap each text node individually
      return wrapRangeMulti(range, h);
    }
  }

  // Handles selections that span multiple DOM elements by wrapping each text node separately
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

      // Split off the portion after our selection (must happen before the start split)
      if (end < tNode.nodeValue.length) tNode.splitText(end);
      const target = start > 0 ? tNode.splitText(start) : tNode;

      const mark = document.createElement('mark');
      mark.className = 'oc-highlight' + (h.comment ? ' oc-highlight-comment' : '');
      mark.dataset.ocId = h.id;
      mark.title = h.comment || '';
      target.parentNode.insertBefore(mark, target);
      mark.appendChild(target);
      mark.addEventListener('click', e => {
        e.stopPropagation();
        if (!highlightMode) showNoteBubble(mark, h);
      });
      if (!firstMark) firstMark = mark;
    }
    return firstMark;
  }

  // ── Highlight mode ─────────────────────────────────────────────
  function enterHighlightMode() {
    if (highlightMode) return;
    highlightMode = true;
    removeToolbar();
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

  // Listen for messages from popup
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'oc-toggle-highlight-mode') {
      if (highlightMode) exitHighlightMode();
      else enterHighlightMode();
      sendResponse({ ok: true });
    }
    if (msg.type === 'oc-get-word-count') {
      sendResponse({ wordCount: getArticleWordCount() });
      return;
    }
    if (msg.type === 'oc-delete-highlight') {
      document.querySelectorAll(`mark[data-oc-id="${msg.id}"]`).forEach(mark => {
        const parent = mark.parentNode;
        while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
        parent.removeChild(mark);
        parent.normalize();
      });
      sendResponse({ ok: true });
    }
  });

  // ── Remove helpers ─────────────────────────────────────────────
  function removeToolbar() {
    if (toolbar) { toolbar.remove(); toolbar = null; }
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
    notifyHighlightChanged('update', h.text, h.id);
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
      saveHighlight(pendingText, pendingRange, '', (h, mark) => {
        if (mark) showAnnotationPopup(mark, h);
      });
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
  let lastSavedText = '';
  let lastSavedTime = 0;

  function saveHighlight(text, range, comment, onDone) {
    // Dedup guard: reject identical text saved within 2 seconds
    const now = Date.now();
    if (text === lastSavedText && now - lastSavedTime < 2000) return;

    const h = {
      id: now.toString(),
      text,
      comment,
      timestamp: new Date().toISOString()
    };

    // Wrap in DOM first — only persist if the visual highlight succeeds
    const mark = wrapRange(range, h);
    if (!mark) return;

    lastSavedText = text;
    lastSavedTime = now;
    window.getSelection()?.removeAllRanges();

    getHighlights(highlights => {
      highlights.push(h);
      saveHighlights(highlights, () => {
        notifyHighlightChanged('create', text, h.id);
        if (onDone) onDone(h, mark);
      });
    });
  }

  function deleteHighlight(id, markEl) {
    // Remove all marks with this id (multi-element highlights create several <mark>s)
    document.querySelectorAll(`mark[data-oc-id="${id}"]`).forEach(mark => {
      const parent = mark.parentNode;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parent.normalize();
    });
    getHighlights(highlights => {
      saveHighlights(highlights.filter(h => h.id !== id));
    });
    notifyHighlightChanged('delete', '', id);
  }

  // ── Notify background of highlight changes ─────────────────────
  // action: 'create' | 'update' | 'delete'
  function notifyHighlightChanged(action, text, highlightId) {
    if (!isContextValid()) return;
    try {
      chrome.runtime.sendMessage({
        type: 'oc-highlight-changed',
        pageKey: pageKey(),
        action,
        text,
        highlightId
      });
    } catch (e) {}
  }

  // ── Word count helper ─────────────────────────────────────────────
  function getArticleWordCount() {
    const el = document.querySelector('article')
      || document.querySelector('[role="main"]')
      || document.body;
    const text = (el.innerText || el.textContent || '').trim();
    return text.split(/\s+/).filter(w => w.length > 0).length;
  }

  // ── Selection listener ───────────────────────────────────────────
  document.addEventListener('mouseup', e => {
    if (toolbar && toolbar.contains(e.target)) return;
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
        const clonedRange = range.cloneRange();
        sel.removeAllRanges(); // Clear immediately to prevent duplicate mouseup saves
        saveHighlight(text, clonedRange, '', (h, mark) => {
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
    if (noteBubble && !noteBubble.contains(e.target)) removeNoteBubble();
    if (annotationPopup && !annotationPopup.contains(e.target)) removeAnnotationPopup();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (highlightMode) exitHighlightMode();
      removeToolbar();
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

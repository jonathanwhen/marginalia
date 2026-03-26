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
  let sidebar = null;
  let sidebarSaveTimer = null;

  // ── Page key resolution ──────────────────────────────────────────
  // If this tab's URL is linked as a conversationUrl on a reading,
  // route all highlights/notes to that reading's pageKey instead.
  let _resolvedPageKey = null;
  let _linkedReadingTitle = null;
  // For YouTube, include the video ID query param so each video gets its own reading
  function defaultPageKey() {
    if (location.hostname === 'www.youtube.com' || location.hostname === 'youtube.com') {
      const v = new URLSearchParams(location.search).get('v');
      if (v) return location.origin + location.pathname + '?v=' + v;
    }
    return location.origin + location.pathname;
  }
  const pageKey = () => _resolvedPageKey || defaultPageKey();

  function resolvePageKey() {
    try {
      chrome.runtime.sendMessage(
        { type: 'oc-resolve-conversation', url: location.href },
        response => {
          if (response?.pageKey) {
            _resolvedPageKey = response.pageKey;
            _linkedReadingTitle = response.reading?.title || null;
          }
        }
      );
    } catch (e) {}
  }
  resolvePageKey();
  const isPdf = document.contentType === 'application/pdf' || location.pathname.toLowerCase().endsWith('.pdf');

  // ── HTML escaping ──────────────────────────────────────────────────
  function escHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ── KaTeX loading for content script ──────────────────────────────
  // KaTeX JS/CSS are bundled in lib/ and declared as web_accessible_resources.
  // We load them on demand so math rendering works in note bubbles and popups.
  let katexLoaded = false;
  let katexLoadPromise = null;

  function ensureKatex() {
    if (katexLoaded && typeof katex !== 'undefined') return Promise.resolve();
    if (katexLoadPromise) return katexLoadPromise;
    katexLoadPromise = new Promise((resolve) => {
      try {
        // Load CSS
        if (!document.querySelector('link[data-oc-katex]')) {
          const link = document.createElement('link');
          link.rel = 'stylesheet';
          link.href = chrome.runtime.getURL('lib/katex.min.css');
          link.dataset.ocKatex = '1';
          document.head.appendChild(link);
        }
        // Load JS
        if (typeof katex !== 'undefined') {
          katexLoaded = true;
          resolve();
          return;
        }
        const script = document.createElement('script');
        script.src = chrome.runtime.getURL('lib/katex.min.js');
        script.onload = () => { katexLoaded = true; resolve(); };
        script.onerror = () => resolve(); // degrade gracefully
        document.head.appendChild(script);
      } catch {
        resolve(); // degrade gracefully if extension context is invalid
      }
    });
    return katexLoadPromise;
  }

  // ── Markdown + DOMPurify loading for sidebar preview ──────────────
  let markdownLibsLoaded = false;
  let markdownLibsPromise = null;

  function ensureMarkdownLibs() {
    if (markdownLibsLoaded) return Promise.resolve();
    if (markdownLibsPromise) return markdownLibsPromise;
    markdownLibsPromise = ensureKatex().then(() => new Promise((resolve) => {
      try {
        let remaining = 0;
        const done = () => { remaining--; if (remaining <= 0) { markdownLibsLoaded = true; resolve(); } };

        if (typeof marked === 'undefined') {
          remaining++;
          const s = document.createElement('script');
          s.src = chrome.runtime.getURL('lib/marked.min.js');
          s.onload = done; s.onerror = done;
          document.head.appendChild(s);
        }
        if (typeof DOMPurify === 'undefined') {
          remaining++;
          const s = document.createElement('script');
          s.src = chrome.runtime.getURL('lib/dompurify.min.js');
          s.onload = done; s.onerror = done;
          document.head.appendChild(s);
        }
        if (remaining === 0) { markdownLibsLoaded = true; resolve(); }
      } catch { resolve(); }
    }));
    return markdownLibsPromise;
  }

  function renderSidebarMarkdown(text) {
    if (!text) return '';
    if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') return escHtml(text);
    let html = marked.parse(text);
    html = DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
    if (typeof katex !== 'undefined') {
      html = html.replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex) => {
        try { return katex.renderToString(tex.trim(), { displayMode: true, throwOnError: false }); }
        catch { return `<code>${escHtml(tex)}</code>`; }
      });
      html = html.replace(/(?<!\$)\$(?!\$)((?:[^$\\]|\\.)+?)\$/g, (_m, tex) => {
        try { return katex.renderToString(tex.trim(), { displayMode: false, throwOnError: false }); }
        catch { return `<code>${escHtml(tex)}</code>`; }
      });
    }
    return html;
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

  // Inject a highlight into the DOM. wrapFn controls styling/behavior (own vs shared).
  function injectHighlight(h, wrapFn) {
    const wrap = wrapFn || wrapRange;
    // Primary: anchor-based restoration (CSS selector + text offset + prefix/suffix verification)
    if (h.anchor) {
      const range = restoreFromAnchor(h.anchor, h.text);
      if (range) { wrap(range, h); return; }
    }

    // Fallback: whitespace-normalized text search
    const normalizedTarget = h.text.replace(/\s+/g, ' ');
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node, accumulated = '', nodes = [];
    while ((node = walker.nextNode())) {
      nodes.push({ node, start: accumulated.length });
      accumulated += node.nodeValue;
    }

    const normalizedAccum = accumulated.replace(/\s+/g, ' ');
    const idx = normalizedAccum.indexOf(normalizedTarget);
    if (idx === -1) return;

    // Map normalized index back to original text positions
    let origIdx = mapNormalizedToOriginal(accumulated, idx);
    let origEnd = mapNormalizedToOriginal(accumulated, idx + normalizedTarget.length);

    // Find the text nodes that contain the start and end positions
    let startNode = null, startOff = 0, endNode = null, endOff = 0;
    for (const { node: n, start } of nodes) {
      const nEnd = start + n.nodeValue.length;
      if (startNode === null && origIdx < nEnd) {
        startNode = n;
        startOff = origIdx - start;
      }
      if (origEnd <= nEnd) {
        endNode = n;
        endOff = origEnd - start;
        break;
      }
    }
    if (!startNode || !endNode) return;

    const range = document.createRange();
    range.setStart(startNode, startOff);
    range.setEnd(endNode, endOff);
    wrap(range, h);
  }

  // Map a character index in whitespace-normalized text back to original text
  function mapNormalizedToOriginal(original, normalizedIdx) {
    let ni = 0, oi = 0, inSpace = false;
    while (oi < original.length && ni < normalizedIdx) {
      if (/\s/.test(original[oi])) {
        if (!inSpace) { ni++; inSpace = true; }
        oi++;
      } else {
        ni++;
        oi++;
        inSpace = false;
      }
    }
    return oi;
  }

  // Restore a highlight range from its anchor data
  function restoreFromAnchor(anchor, text) {
    try {
      const { cssSelector, textOffset, prefix, suffix } = anchor;
      const ancestor = document.querySelector(cssSelector);
      if (!ancestor) return null;

      // Walk text nodes within ancestor to find the offset
      const walker = document.createTreeWalker(ancestor, NodeFilter.SHOW_TEXT);
      let node, pos = 0, startNode = null, startOff = 0, endNode = null, endOff = 0;
      while ((node = walker.nextNode())) {
        const len = node.nodeValue.length;
        if (startNode === null && pos + len > textOffset) {
          startNode = node;
          startOff = textOffset - pos;
        }
        if (pos + len >= textOffset + text.length) {
          endNode = node;
          endOff = textOffset + text.length - pos;
          break;
        }
        pos += len;
      }
      if (!startNode || !endNode) return null;

      // Verify with prefix/suffix context
      const range = document.createRange();
      range.setStart(startNode, startOff);
      range.setEnd(endNode, endOff);
      const rangeText = range.toString();

      // Verify the range text matches (allowing whitespace differences)
      if (rangeText.replace(/\s+/g, ' ') !== text.replace(/\s+/g, ' ')) return null;

      // Verify prefix/suffix context if present
      if (prefix) {
        const fullText = ancestor.textContent;
        const rangeStart = textOffset;
        const contextBefore = fullText.slice(Math.max(0, rangeStart - prefix.length), rangeStart);
        if (!contextBefore.endsWith(prefix)) return null;
      }
      if (suffix) {
        const fullText = ancestor.textContent;
        const rangeEnd = textOffset + text.length;
        const contextAfter = fullText.slice(rangeEnd, rangeEnd + suffix.length);
        if (!contextAfter.startsWith(suffix)) return null;
      }

      return range;
    } catch {
      return null;
    }
  }

  // Compute anchor data for a highlight selection
  function computeAnchor(range, text) {
    try {
      // Find a good ancestor element with a CSS selector
      let ancestor = range.commonAncestorContainer;
      if (ancestor.nodeType === Node.TEXT_NODE) ancestor = ancestor.parentElement;

      // Walk up to find an element with an id or unique selector
      let target = ancestor;
      let cssSelector = null;
      while (target && target !== document.body) {
        if (target.id) {
          cssSelector = `#${CSS.escape(target.id)}`;
          break;
        }
        // Try tag + nth-child for specificity
        const parent = target.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter(c => c.tagName === target.tagName);
          const idx = siblings.indexOf(target) + 1;
          const parentSel = getCssPath(parent);
          if (parentSel) {
            cssSelector = `${parentSel} > ${target.tagName.toLowerCase()}:nth-of-type(${idx})`;
            break;
          }
        }
        target = parent;
      }

      if (!cssSelector) {
        cssSelector = getCssPath(ancestor);
      }
      if (!cssSelector) return null;

      // Compute text offset within the ancestor
      const resolvedAncestor = document.querySelector(cssSelector);
      if (!resolvedAncestor) return null;

      const walker = document.createTreeWalker(resolvedAncestor, NodeFilter.SHOW_TEXT);
      let node, textOffset = 0, found = false;
      while ((node = walker.nextNode())) {
        if (node === range.startContainer) {
          textOffset += range.startOffset;
          found = true;
          break;
        }
        textOffset += node.nodeValue.length;
      }
      if (!found) return null;

      // Extract prefix/suffix context (up to 32 chars)
      const fullText = resolvedAncestor.textContent;
      const prefix = fullText.slice(Math.max(0, textOffset - 32), textOffset);
      const suffix = fullText.slice(textOffset + text.length, textOffset + text.length + 32);

      return { cssSelector, textOffset, prefix, suffix };
    } catch {
      return null;
    }
  }

  // Build a CSS selector path for an element
  function getCssPath(el) {
    if (!el || el === document.body) return 'body';
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts = [];
    let current = el;
    for (let i = 0; i < 5 && current && current !== document.body; i++) {
      if (current.id) {
        parts.unshift(`#${CSS.escape(current.id)}`);
        break;
      }
      const parent = current.parentElement;
      if (!parent) break;
      const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
      const idx = siblings.indexOf(current) + 1;
      parts.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${idx})`);
      current = parent;
    }
    return parts.join(' > ') || null;
  }

  // Returns the first created <mark> element (or null on failure).
  // opts.shared: if true, uses shared highlight styling (read-only, blue).
  function wrapRange(range, h, opts) {
    const shared = opts?.shared;
    try {
      const mark = document.createElement('mark');
      mark.className = shared
        ? 'oc-highlight-shared' + (h.comment ? ' oc-highlight-shared-comment' : '')
        : 'oc-highlight' + (h.comment ? ' oc-highlight-comment' : '');
      mark.dataset.ocId = h.id;
      if (!shared) mark.title = h.comment || '';
      range.surroundContents(mark);
      mark.addEventListener('click', e => {
        e.stopPropagation();
        if (shared) showSharedNoteBubble(mark, h);
        else if (!highlightMode) showNoteBubble(mark, h);
      });
      return mark;
    } catch (e) {
      return wrapRangeMulti(range, h, opts);
    }
  }

  function wrapRangeMulti(range, h, opts) {
    const shared = opts?.shared;
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
      mark.className = shared
        ? 'oc-highlight-shared' + (h.comment ? ' oc-highlight-shared-comment' : '')
        : 'oc-highlight' + (h.comment ? ' oc-highlight-comment' : '');
      mark.dataset.ocId = h.id;
      if (!shared) mark.title = h.comment || '';
      target.parentNode.insertBefore(mark, target);
      mark.appendChild(target);
      mark.addEventListener('click', e => {
        e.stopPropagation();
        if (shared) showSharedNoteBubble(mark, h);
        else if (!highlightMode) showNoteBubble(mark, h);
      });
      if (!firstMark) firstMark = mark;
    }
    return firstMark;
  }

  // ── Highlight mode ─────────────────────────────────────────────
  function enterHighlightMode() {
    if (highlightMode) return;
    highlightMode = true;
    ensureKatex(); // preload KaTeX so it's ready for note bubbles
    removeToolbar();
    removeNoteBubble();
    removeAnnotationPopup();

    modeBanner = document.createElement('div');
    modeBanner.id = 'oc-mode-banner';
    modeBanner.innerHTML = `
      <span class="oc-banner-icon">✦</span>
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
    if (msg.type === 'oc-open-sidebar') {
      openNotesSidebar();
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'oc-toggle-highlight-mode') {
      if (isPdf) {
        sendResponse({ ok: false, pdf: true });
        return;
      }
      if (highlightMode) exitHighlightMode();
      else enterHighlightMode();
      sendResponse({ ok: true });
    }
    if (msg.type === 'oc-get-word-count') {
      sendResponse({ wordCount: isPdf ? 0 : getArticleWordCount() });
      return;
    }
    if (msg.type === 'oc-get-page-text') {
      const el = document.querySelector('article')
        || document.querySelector('[role="main"]')
        || document.body;
      const text = (el.innerText || el.textContent || '').trim();
      // Cap at ~100k chars to avoid clipboard/memory issues
      sendResponse({ text: text.slice(0, 100000) });
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
      <div class="oc-ann-hint">Use $...$ for math</div>
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
      saveHighlights(highlights, () => ensureReadingExists());
    });
    notifyHighlightChanged('update', h.text, h.id);
  }

  // ── Toolbar (used outside highlight mode) ──────────────────────
  // Sites where native selection UI conflicts with our toolbar above the selection
  const showToolbarBelow = /(^|\.)claude\.ai$|(^|\.)chatgpt\.com$/.test(location.hostname);

  function showToolbar(x, y, text, range) {
    removeToolbar();
    pendingText = text;
    pendingRange = range.cloneRange();

    toolbar = document.createElement('div');
    toolbar.id = 'oc-toolbar';
    toolbar.innerHTML = `
      <span>✦</span>
      <button id="oc-btn-highlight">Highlight</button>
      <div class="oc-divider"></div>
      <button id="oc-btn-comment">+ Comment</button>
    `;
    document.body.appendChild(toolbar);

    const vw = window.innerWidth;
    const rect = range.getBoundingClientRect();
    let tx = x - toolbar.offsetWidth / 2;
    let ty;
    if (showToolbarBelow) {
      // Position below the selection to avoid conflicting with site reply buttons
      ty = rect.bottom + window.scrollY + 8;
    } else {
      ty = y - 48;
    }
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
    ensureKatex().then(() => renderNoteBubbleContent(anchor, h));
  }

  function renderNoteBubbleContent(anchor, h) {
    removeNoteBubble(); // guard against race if called twice
    const hasComment = !!h.comment;
    noteBubble = document.createElement('div');
    noteBubble.id = 'oc-note-bubble';
    noteBubble.innerHTML = `
      <div class="oc-nb-quote">${escHtml(h.text.length > 120 ? h.text.slice(0, 120) + '\u2026' : h.text)}</div>
      ${h.latex ? `<div class="oc-nb-latex">${renderLatex(h.latex)}</div>` : ''}
      ${hasComment ? `<div class="oc-nb-comment">${renderMathInText(h.comment)}</div>` : ''}
      <div class="oc-nb-edit-section" style="display:none;">
        <textarea class="oc-nb-edit-input" placeholder="Add a note... (use $...$ for math)">${escHtml(h.comment || '')}</textarea>
        <div class="oc-nb-edit-hint">Use $...$ for inline math, $$...$$ for display math</div>
        <div class="oc-nb-edit-actions">
          <button class="oc-nb-edit-save">Save</button>
          <button class="oc-nb-edit-cancel">Cancel</button>
        </div>
      </div>
      <div class="oc-nb-actions">
        <span class="oc-nb-edit-btn">${hasComment ? '\u270e Edit note' : '\u270e Add note'}</span>
        <span class="oc-nb-delete">\u2715 Remove</span>
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

  // ── Math detection on web pages ──────────────────────────────────
  function extractMathFromSelection(range) {
    const container = range.commonAncestorContainer;
    const root = container.nodeType === Node.TEXT_NODE ? container.parentElement : container;
    if (!root) return null;

    const latex = [];
    const mathElements = [];

    // Expand search to include ancestors that may contain the math context
    const searchRoot = root.closest?.('.katex, .MathJax, .MathJax_Display, mjx-container, [data-mathml]') || root;

    // KaTeX: .katex elements contain annotation[encoding="application/x-tex"]
    searchRoot.querySelectorAll?.('.katex')?.forEach(el => {
      if (!range.intersectsNode(el)) return;
      const ann = el.querySelector('annotation[encoding="application/x-tex"]');
      if (ann?.textContent) {
        latex.push(ann.textContent.trim());
        mathElements.push({ type: 'katex', source: ann.textContent.trim() });
      }
    });

    // Also check ancestors for KaTeX
    if (!latex.length) {
      const katexParent = root.closest?.('.katex');
      if (katexParent) {
        const ann = katexParent.querySelector('annotation[encoding="application/x-tex"]');
        if (ann?.textContent) {
          latex.push(ann.textContent.trim());
          mathElements.push({ type: 'katex', source: ann.textContent.trim() });
        }
      }
    }

    // MathJax v2: script[type*="math/tex"] siblings of .MathJax elements
    searchRoot.querySelectorAll?.('.MathJax')?.forEach(el => {
      if (!range.intersectsNode(el)) return;
      const script = el.previousElementSibling;
      if (script?.tagName === 'SCRIPT' && script.type?.includes('math/tex')) {
        latex.push(script.textContent.trim());
        mathElements.push({ type: 'mathjax-v2', source: script.textContent.trim() });
      }
    });

    // MathJax v3: mjx-container elements
    searchRoot.querySelectorAll?.('mjx-container')?.forEach(el => {
      if (!range.intersectsNode(el)) return;
      // MathJax v3 stores original TeX in an attribute or assistive MathML
      const texAttr = el.getAttribute('data-mjx-texcode');
      if (texAttr) {
        latex.push(texAttr);
        mathElements.push({ type: 'mathjax-v3', source: texAttr });
      }
      // Try assistive MathML annotation
      const ann = el.querySelector('annotation[encoding="application/x-tex"]');
      if (ann?.textContent && !texAttr) {
        latex.push(ann.textContent.trim());
        mathElements.push({ type: 'mathjax-v3', source: ann.textContent.trim() });
      }
    });

    // Also check ancestors for MathJax v3
    if (!latex.length) {
      const mjxParent = root.closest?.('mjx-container');
      if (mjxParent) {
        const ann = mjxParent.querySelector('annotation[encoding="application/x-tex"]');
        if (ann?.textContent) {
          latex.push(ann.textContent.trim());
          mathElements.push({ type: 'mathjax-v3', source: ann.textContent.trim() });
        }
      }
    }

    // MathML: <math> elements with <annotation> or raw MathML
    searchRoot.querySelectorAll?.('math')?.forEach(el => {
      if (!range.intersectsNode(el)) return;
      const ann = el.querySelector('annotation[encoding="application/x-tex"]');
      if (ann?.textContent) {
        latex.push(ann.textContent.trim());
        mathElements.push({ type: 'mathml', source: ann.textContent.trim() });
      } else {
        // Store raw MathML as fallback
        mathElements.push({ type: 'mathml-raw', source: el.outerHTML });
      }
    });

    if (!latex.length && !mathElements.length) return null;
    return {
      latex: latex.join('\n') || undefined,
      mathElements: mathElements.length ? mathElements : undefined
    };
  }

  // ── Save / delete highlights ───────────────────────────────────
  let lastSavedText = '';
  let lastSavedTime = 0;

  function saveHighlight(text, range, comment, onDone) {
    // Dedup guard: reject identical text saved within 2 seconds
    const now = Date.now();
    if (text === lastSavedText && now - lastSavedTime < 2000) return;

    const anchor = computeAnchor(range, text);
    const mathData = extractMathFromSelection(range);
    const h = {
      id: crypto.randomUUID(),
      text,
      comment,
      timestamp: new Date().toISOString(),
      ...(anchor ? { anchor } : {}),
      ...(mathData?.latex ? { latex: mathData.latex } : {}),
      ...(mathData?.mathElements ? { mathElements: mathData.mathElements } : {})
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
        ensureReadingExists();
        notifyHighlightChanged('create', text, h.id);
        // Push to collab session if active
        if (window.__collabState) {
          try {
            chrome.runtime.sendMessage({
              type: 'oc-collab-push',
              collabPageId: window.__collabState.collabPageId,
              highlight: h
            });
          } catch (e) { console.warn('collab push failed:', e); }
        }
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

  // ── Ensure a reading exists for this page ──────────────────────
  // Called after every highlight save so the reading is auto-created
  // with rich metadata (author, estPages) even without opening the popup.
  function ensureReadingExists() {
    if (!isContextValid()) return;
    try {
      const isYouTube = location.hostname === 'www.youtube.com' || location.hostname === 'youtube.com';
      const msg = {
        type: 'oc-upsert-reading',
        pageKey: pageKey(),
        title: document.title || pageKey(),
        url: location.href
      };

      if (isYouTube) {
        // YouTube: extract channel name and video duration
        msg.mediaType = 'video';
        const channel = document.querySelector('#channel-name a')?.textContent?.trim()
          || document.querySelector('ytd-channel-name a')?.textContent?.trim()
          || document.querySelector('meta[itemprop="author"] link[itemprop="name"]')?.getAttribute('content');
        if (channel) msg.author = channel;
        // Duration from the video player or structured data
        const durMeta = document.querySelector('meta[itemprop="duration"]')?.content;
        if (durMeta) {
          // ISO 8601 duration like PT12M34S or PT1H2M3S
          const m = durMeta.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
          if (m) msg.duration = (parseInt(m[1] || 0) * 60) + parseInt(m[2] || 0) + (parseInt(m[3] || 0) >= 30 ? 1 : 0);
        }
      } else {
        msg.author =
          document.querySelector('meta[name="author"]')?.content ||
          document.querySelector('meta[property="article:author"]')?.content ||
          document.querySelector('[class*="author"] [itemprop="name"]')?.textContent?.trim() ||
          undefined;
        const wordCount = document.body?.innerText?.split(/\s+/).length || 0;
        msg.estPages = wordCount > 0 ? Math.max(1, Math.round(wordCount / 275)) : undefined;
      }

      chrome.runtime.sendMessage(msg);
    } catch (e) {}
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
    // Refresh sidebar highlights list if open
    loadSidebarHighlights();
  }

  // ── Word count helper ─────────────────────────────────────────────
  function getArticleWordCount() {
    const el = document.querySelector('article')
      || document.querySelector('[role="main"]')
      || document.body;
    const text = (el.innerText || el.textContent || '').trim();
    return text.split(/\s+/).filter(w => w.length > 0).length;
  }

  // ── Notes sidebar ─────────────────────────────────────────────────
  function openNotesSidebar() {
    if (sidebar) return; // already open

    sidebar = document.createElement('div');
    sidebar.id = 'oc-sidebar';

    const isLinkedConversation = !!_resolvedPageKey;
    const titleText = _linkedReadingTitle || document.title || pageKey();
    const truncTitle = titleText.length > 40 ? titleText.slice(0, 40) + '…' : titleText;

    const linkedBannerHtml = isLinkedConversation
      ? `<div class="oc-sb-linked-banner">Linked to: ${escHtml(truncTitle)}</div>`
      : '';

    sidebar.innerHTML = `
      <div class="oc-sb-header">
        <span class="oc-sb-logo">✦</span>
        <span class="oc-sb-title">${isLinkedConversation ? 'Notes: "' + escHtml(truncTitle) + '"' : 'Notes: "' + escHtml(truncTitle) + '"'}</span>
        <button class="oc-sb-close" title="Close (Esc)">✕</button>
      </div>
      ${linkedBannerHtml}
      <div class="oc-sb-body">
        ${isLinkedConversation ? '' : '<div class="oc-sb-conv-row"><input class="oc-sb-conv-input" type="url" placeholder="Claude conversation URL..." /></div>'}
        <div class="oc-sb-notes-header">
          <span class="oc-sb-label">Notes</span>
          <button class="oc-sb-preview-toggle" title="Toggle preview">Preview</button>
        </div>
        <textarea class="oc-sb-textarea" placeholder="Key takeaways, thoughts, or insights... (Markdown supported)"></textarea>
        <div class="oc-sb-preview" style="display:none;"></div>
        <div class="oc-sb-status"></div>
        <div class="oc-sb-divider"></div>
        <div class="oc-sb-hl-header">Highlights (0)</div>
        <div class="oc-sb-hl-list">
          <div class="oc-sb-hl-empty">No highlights on this page.</div>
        </div>
      </div>
    `;

    document.body.appendChild(sidebar);
    document.documentElement.style.marginRight = '380px';

    const textarea = sidebar.querySelector('.oc-sb-textarea');
    const statusEl = sidebar.querySelector('.oc-sb-status');
    const convInput = sidebar.querySelector('.oc-sb-conv-input');
    const previewEl = sidebar.querySelector('.oc-sb-preview');
    const previewBtn = sidebar.querySelector('.oc-sb-preview-toggle');
    let previewMode = false;

    // Load existing notes + conversation URL from reading
    if (isContextValid()) {
      try {
        chrome.runtime.sendMessage({ type: 'oc-get-reading', pageKey: pageKey() }, response => {
          if (response?.reading?.notes) {
            textarea.value = response.reading.notes;
          }
          if (convInput && response?.reading?.conversationUrl) {
            convInput.value = response.reading.conversationUrl;
          }
        });
      } catch (e) {}
    }

    // Load highlights list
    loadSidebarHighlights();

    // Preview toggle
    previewBtn.addEventListener('click', () => {
      previewMode = !previewMode;
      if (previewMode) {
        previewBtn.textContent = 'Edit';
        textarea.style.display = 'none';
        previewEl.style.display = 'block';
        ensureMarkdownLibs().then(() => {
          previewEl.innerHTML = renderSidebarMarkdown(textarea.value);
        });
      } else {
        previewBtn.textContent = 'Preview';
        textarea.style.display = '';
        previewEl.style.display = 'none';
        textarea.focus();
      }
    });

    // Auto-save on typing (debounced 1s)
    textarea.addEventListener('input', () => {
      statusEl.textContent = '';
      statusEl.className = 'oc-sb-status';
      clearTimeout(sidebarSaveTimer);
      sidebarSaveTimer = setTimeout(() => saveSidebarNote(textarea, statusEl, convInput), 1000);
    });

    // Save conversation URL on change
    if (convInput) {
      convInput.addEventListener('change', () => {
        saveSidebarNote(textarea, statusEl, convInput);
        // Re-resolve pageKey after linking a conversation
        resolvePageKey();
      });
    }

    // Cmd/Ctrl+S for immediate save
    textarea.addEventListener('keydown', e => {
      if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        clearTimeout(sidebarSaveTimer);
        saveSidebarNote(textarea, statusEl, convInput);
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeNotesSidebar();
      }
    });

    // Close button
    sidebar.querySelector('.oc-sb-close').addEventListener('click', closeNotesSidebar);

    // Focus textarea
    textarea.focus();
  }

  function closeNotesSidebar() {
    if (!sidebar) return;
    // Flush any pending save
    if (sidebarSaveTimer) {
      clearTimeout(sidebarSaveTimer);
      const textarea = sidebar.querySelector('.oc-sb-textarea');
      const statusEl = sidebar.querySelector('.oc-sb-status');
      const convInput = sidebar.querySelector('.oc-sb-conv-input');
      if (textarea && statusEl) saveSidebarNote(textarea, statusEl, convInput);
    }
    sidebar.remove();
    sidebar = null;
    document.documentElement.style.marginRight = '';
  }

  function saveSidebarNote(textarea, statusEl, convInput) {
    const notes = textarea.value.trim();
    const conversationUrl = convInput?.value?.trim() || null;
    if (!isContextValid()) return;
    try {
      chrome.runtime.sendMessage({
        type: 'oc-upsert-reading',
        pageKey: pageKey(),
        title: document.title || pageKey(),
        url: location.href,
        notes,
        conversationUrl
      }, result => {
        if (result?.ok) {
          statusEl.textContent = 'Saved';
          statusEl.className = 'oc-sb-status saved';
          setTimeout(() => {
            if (statusEl.textContent === 'Saved') {
              statusEl.textContent = '';
              statusEl.className = 'oc-sb-status';
            }
          }, 2000);
        }
      });
    } catch (e) {}
  }

  function loadSidebarHighlights() {
    if (!sidebar) return;
    const headerEl = sidebar.querySelector('.oc-sb-hl-header');
    const listEl = sidebar.querySelector('.oc-sb-hl-list');

    getHighlights(highlights => {
      if (!sidebar) return; // closed while loading
      headerEl.textContent = `Highlights (${highlights.length})`;

      if (!highlights.length) {
        listEl.innerHTML = '<div class="oc-sb-hl-empty">No highlights on this page.</div>';
        return;
      }

      // Ensure KaTeX is loaded before rendering sidebar highlights with math
      ensureKatex().then(() => {
        if (!sidebar) return; // may have closed during load
        listEl.innerHTML = highlights.map(h => `
          <div class="oc-sb-hl-item">
            <div class="oc-sb-hl-quote">"${escHtml(h.text.length > 120 ? h.text.slice(0, 120) + '\u2026' : h.text)}"</div>
            ${h.latex ? `<div class="oc-sb-hl-latex">${renderLatex(h.latex)}</div>` : ''}
            ${h.comment ? `<div class="oc-sb-hl-comment">\u2014 ${renderMathInText(h.comment)}</div>` : ''}
          </div>
        `).join('');
      });
    });
  }

  // ── PDF: skip DOM-based highlighting (context menu captures still work via background.js)
  if (isPdf) return;

  // ── Selection listener ───────────────────────────────────────────
  document.addEventListener('mouseup', e => {
    if (toolbar && toolbar.contains(e.target)) return;
    if (modeBanner && modeBanner.contains(e.target)) return;
    if (noteBubble && noteBubble.contains(e.target)) return;
    if (annotationPopup && annotationPopup.contains(e.target)) return;
    if (sidebar && sidebar.contains(e.target)) return;

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
      if (sidebar) { closeNotesSidebar(); return; }
      if (highlightMode) exitHighlightMode();
      removeToolbar();
      removeNoteBubble();
      removeAnnotationPopup();
    }
  });

  // ── Shared highlights overlay ────────────────────────────────────
  // Detects #marginalia-share=CODE in the URL and fetches + renders
  // shared highlights from Supabase with an attribution banner.

  const SUPABASE_URL = 'https://lfvbrrxnjwanbniaegnf.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxmdmJycnhuandhbmJuaWFlZ25mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI2NzAxMDYsImV4cCI6MjA4ODI0NjEwNn0.6NzXByK1y8FP-iCqYx6GCiuG6DsIvXpbkyqiCX_R1Os';

  function getShareCodeFromHash() {
    const hash = location.hash;
    const match = hash.match(/^#marginalia-share=([a-z0-9]+)$/);
    return match ? match[1] : null;
  }

  async function loadSharedHighlights(shareCode) {
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/shared_pages?share_code=eq.${encodeURIComponent(shareCode)}&select=*,profiles(display_name)`,
        { headers: { 'apikey': SUPABASE_ANON_KEY } }
      );
      if (!res.ok) return;
      const data = await res.json();
      if (!data.length) return;

      const shared = data[0];
      const highlights = shared.highlights || [];
      const sharedBy = shared.profiles?.display_name || 'Someone';

      // Show attribution banner
      showShareBanner(sharedBy, shared.title, highlights.length);

      // Render shared highlights using parameterized wrapRange
      const sharedWrap = (range, h) => wrapRange(range, h, { shared: true });
      highlights.forEach(h => {
        const sharedH = { ...h, id: 'shared-' + (h.id || crypto.randomUUID()) };
        injectHighlight(sharedH, sharedWrap);
      });
    } catch (e) {
      // Silently fail — don't disrupt page if fetch fails
    }
  }

  function showSharedNoteBubble(anchor, h) {
    removeNoteBubble();
    ensureKatex().then(() => {
      removeNoteBubble(); // guard against race
      noteBubble = document.createElement('div');
      noteBubble.id = 'oc-note-bubble';
      noteBubble.innerHTML = `
        <div class="oc-nb-quote">${escHtml(h.text.length > 120 ? h.text.slice(0, 120) + '\u2026' : h.text)}</div>
        ${h.latex ? `<div class="oc-nb-latex">${renderLatex(h.latex)}</div>` : ''}
        ${h.comment ? `<div class="oc-nb-comment">${renderMathInText(h.comment)}</div>` : ''}
        <div style="margin-top:6px; padding-top:6px; border-top:1px solid #222; font-size:10px; color:#555;">Shared annotation (read-only)</div>
      `;
      document.body.appendChild(noteBubble);

      const rect = anchor.getBoundingClientRect();
      let nx = rect.left + window.scrollX;
      let ny = rect.bottom + window.scrollY + 8;
      nx = Math.max(8, Math.min(nx, window.innerWidth - 270));
      noteBubble.style.left = nx + 'px';
      noteBubble.style.top = ny + 'px';
    });
  }

  function showShareBanner(sharedBy, title, highlightCount) {
    const banner = document.createElement('div');
    banner.id = 'oc-share-banner';
    banner.innerHTML = `
      <span class="oc-share-banner-icon">\u2726</span>
      <span class="oc-share-banner-text">
        <strong>${escHtml(sharedBy)}</strong> shared ${highlightCount} annotation${highlightCount !== 1 ? 's' : ''} on this page via Marginalia
      </span>
      <button id="oc-share-banner-close">\u2715</button>
    `;
    document.body.appendChild(banner);
    document.body.style.marginTop = (parseInt(getComputedStyle(document.body).marginTop) || 0) + 40 + 'px';

    banner.querySelector('#oc-share-banner-close').addEventListener('click', () => {
      banner.remove();
      document.body.style.marginTop = '';
      // Remove shared highlights
      const parentsToNormalize = new Set();
      document.querySelectorAll('.oc-highlight-shared').forEach(mark => {
        const parent = mark.parentNode;
        while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
        parent.removeChild(mark);
        parentsToNormalize.add(parent);
      });
      parentsToNormalize.forEach(p => p.normalize());
      // Clean the hash
      history.replaceState(null, '', location.pathname + location.search);
    });
  }

  // ── Collaborative annotations ──────────────────────────────────────
  // One color per collaborator, cycled. Visually distinct from the user's
  // own warm-orange highlights and the blue shared-page overlays.
  const COLLAB_COLORS = [
    '#7c9ae8', // blue
    '#e87ca8', // pink
    '#7ce8b4', // green
    '#c87ce8', // purple
    '#e8c87c', // gold
    '#7ce8e8', // cyan
  ];

  // Track rendered collab annotation IDs to diff against new polls
  let renderedCollabIds = new Set();

  async function initCollab() {
    if (!isContextValid()) return;
    try {
      const auth = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'oc-get-auth' }, resolve);
      });
      if (!auth) return;

      const collab = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'oc-collab-status', pageKey: pageKey() }, resolve);
      });
      if (!collab) return;

      // Store collab state so saveHighlight can push
      window.__collabState = {
        collabPageId: collab.collabPageId,
        userId: auth.userId,
        displayName: auth.displayName
      };

      // Initial pull
      const result = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'oc-collab-pull', collabPageId: collab.collabPageId }, resolve);
      });
      if (result?.annotations) {
        renderCollabAnnotations(result.annotations, auth.userId);
      }

      // Poll every 5s for updates
      setInterval(async () => {
        if (!isContextValid()) return;
        try {
          const r = await new Promise((resolve) => {
            chrome.runtime.sendMessage({ type: 'oc-collab-pull', collabPageId: collab.collabPageId }, resolve);
          });
          if (r?.annotations) renderCollabAnnotations(r.annotations, auth.userId);
        } catch (e) { /* silent */ }
      }, 5000);
    } catch (e) {
      console.warn('collab init failed:', e);
    }
  }

  function renderCollabAnnotations(annotations, myUserId) {
    // Filter out own annotations
    const others = annotations.filter(a => a.userId !== myUserId);
    const newIds = new Set(others.map(a => a.id));

    // If nothing changed, skip re-render
    if (newIds.size === renderedCollabIds.size && [...newIds].every(id => renderedCollabIds.has(id))) {
      return;
    }

    // Remove old collab marks by unwrapping
    const parentsToNormalize = new Set();
    document.querySelectorAll('.oc-collab-highlight').forEach(mark => {
      const parent = mark.parentNode;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parentsToNormalize.add(parent);
    });
    parentsToNormalize.forEach(p => p.normalize());

    // Assign colors to collaborators (stable per userId)
    const userIds = [...new Set(others.map(a => a.userId))];
    const userColors = {};
    userIds.forEach((id, i) => { userColors[id] = COLLAB_COLORS[i % COLLAB_COLORS.length]; });

    // Render each collaborator's highlights
    for (const ann of others) {
      const h = ann.highlight;
      const color = userColors[ann.userId];
      const displayName = ann.displayName;
      injectHighlight(h, (range, highlight) => {
        wrapCollabRange(range, highlight, displayName, color);
      });
    }

    renderedCollabIds = newIds;
  }

  function wrapCollabRange(range, h, displayName, color) {
    try {
      const mark = document.createElement('mark');
      mark.className = 'oc-collab-highlight';
      mark.style.backgroundColor = color + '33'; // 20% opacity
      mark.style.borderBottom = '2px solid ' + color;
      mark.title = displayName + ': ' + (h.comment || h.text?.slice(0, 50) || '');
      mark.dataset.collab = 'true';
      mark.dataset.userName = displayName;
      range.surroundContents(mark);
      mark.addEventListener('click', e => {
        e.stopPropagation();
        showCollabNoteBubble(mark, h, displayName, color);
      });
    } catch (e) {
      // surroundContents can fail on cross-element ranges; wrap individual text nodes
      wrapCollabRangeMulti(range, h, displayName, color);
    }
  }

  function wrapCollabRangeMulti(range, h, displayName, color) {
    const textNodes = [];
    const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (range.intersectsNode(node)) textNodes.push(node);
    }
    for (const tNode of textNodes) {
      let start = 0, end = tNode.nodeValue.length;
      if (tNode === range.startContainer) start = range.startOffset;
      if (tNode === range.endContainer) end = range.endOffset;
      if (start >= end) continue;

      if (end < tNode.nodeValue.length) tNode.splitText(end);
      const target = start > 0 ? tNode.splitText(start) : tNode;

      const mark = document.createElement('mark');
      mark.className = 'oc-collab-highlight';
      mark.style.backgroundColor = color + '33';
      mark.style.borderBottom = '2px solid ' + color;
      mark.title = displayName + ': ' + (h.comment || h.text?.slice(0, 50) || '');
      mark.dataset.collab = 'true';
      mark.dataset.userName = displayName;
      target.parentNode.insertBefore(mark, target);
      mark.appendChild(target);
      mark.addEventListener('click', e => {
        e.stopPropagation();
        showCollabNoteBubble(mark, h, displayName, color);
      });
    }
  }

  function showCollabNoteBubble(anchor, h, displayName, color) {
    removeNoteBubble();
    noteBubble = document.createElement('div');
    noteBubble.id = 'oc-note-bubble';
    noteBubble.innerHTML = `
      <div class="oc-nb-quote">${escHtml(h.text?.length > 120 ? h.text.slice(0, 120) + '\u2026' : (h.text || ''))}</div>
      ${h.comment ? `<div class="oc-nb-comment">${escHtml(h.comment)}</div>` : ''}
      <div style="margin-top:6px; padding-top:6px; border-top:1px solid #222; font-size:10px; color:${color};">
        ${escHtml(displayName)} \u2014 collaborative highlight
      </div>
    `;
    document.body.appendChild(noteBubble);

    const rect = anchor.getBoundingClientRect();
    let nx = rect.left + window.scrollX;
    let ny = rect.bottom + window.scrollY + 8;
    nx = Math.max(8, Math.min(nx, window.innerWidth - 270));
    noteBubble.style.left = nx + 'px';
    noteBubble.style.top = ny + 'px';
  }

  // Apply on load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      applyStoredHighlights();
      const shareCode = getShareCodeFromHash();
      if (shareCode) loadSharedHighlights(shareCode);
      initCollab();
    });
  } else {
    applyStoredHighlights();
    const shareCode = getShareCodeFromHash();
    if (shareCode) loadSharedHighlights(shareCode);
    initCollab();
  }
})();

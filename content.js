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

  const pageKey = () => location.origin + location.pathname;
  const isPdf = document.contentType === 'application/pdf' || location.pathname.toLowerCase().endsWith('.pdf');

  // ── HTML escaping ──────────────────────────────────────────────────
  function escHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
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

  function injectHighlight(h) {
    // Primary: anchor-based restoration (CSS selector + text offset + prefix/suffix verification)
    if (h.anchor) {
      const range = restoreFromAnchor(h.anchor, h.text);
      if (range) { wrapRange(range, h); return; }
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
    wrapRange(range, h);
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
      saveHighlights(highlights, () => ensureReadingExists());
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
      <span>✦</span>
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
      <div class="oc-nb-quote">${escHtml(h.text.length > 120 ? h.text.slice(0, 120) + '…' : h.text)}</div>
      ${h.latex ? `<div class="oc-nb-latex"><code>${escHtml(h.latex)}</code></div>` : ''}
      ${hasComment ? `<div class="oc-nb-comment">${escHtml(h.comment)}</div>` : ''}
      <div class="oc-nb-edit-section" style="display:none;">
        <textarea class="oc-nb-edit-input" placeholder="Add a note...">${escHtml(h.comment || '')}</textarea>
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

  // ── Ensure a reading exists for this page (belt-and-suspenders) ──
  // Called after every highlight save so the reading is guaranteed to
  // exist even if the oc-highlight-changed message is lost.
  function ensureReadingExists() {
    if (!isContextValid()) return;
    try {
      chrome.runtime.sendMessage({
        type: 'oc-upsert-reading',
        pageKey: pageKey(),
        title: document.title || pageKey(),
        url: location.href
      });
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

    const titleText = document.title || pageKey();
    const truncTitle = titleText.length > 40 ? titleText.slice(0, 40) + '…' : titleText;

    sidebar.innerHTML = `
      <div class="oc-sb-header">
        <span class="oc-sb-logo">✦</span>
        <span class="oc-sb-title">Notes: "${truncTitle}"</span>
        <button class="oc-sb-close" title="Close (Esc)">✕</button>
      </div>
      <div class="oc-sb-body">
        <span class="oc-sb-label">Notes</span>
        <textarea class="oc-sb-textarea" placeholder="Key takeaways, thoughts, or insights..."></textarea>
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

    // Load existing notes from reading
    if (isContextValid()) {
      try {
        chrome.runtime.sendMessage({ type: 'oc-get-reading', pageKey: pageKey() }, response => {
          if (response?.reading?.notes) {
            textarea.value = response.reading.notes;
          }
        });
      } catch (e) {}
    }

    // Load highlights list
    loadSidebarHighlights();

    // Auto-save on typing (debounced 1s)
    textarea.addEventListener('input', () => {
      statusEl.textContent = '';
      statusEl.className = 'oc-sb-status';
      clearTimeout(sidebarSaveTimer);
      sidebarSaveTimer = setTimeout(() => saveSidebarNote(textarea, statusEl), 1000);
    });

    // Cmd/Ctrl+S for immediate save
    textarea.addEventListener('keydown', e => {
      if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        clearTimeout(sidebarSaveTimer);
        saveSidebarNote(textarea, statusEl);
      }
      // Prevent Escape from propagating if handled by sidebar close
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
      if (textarea && statusEl) saveSidebarNote(textarea, statusEl);
    }
    sidebar.remove();
    sidebar = null;
    document.documentElement.style.marginRight = '';
  }

  function saveSidebarNote(textarea, statusEl) {
    const notes = textarea.value.trim();
    if (!isContextValid()) return;
    try {
      chrome.runtime.sendMessage({
        type: 'oc-upsert-reading',
        pageKey: pageKey(),
        title: document.title || pageKey(),
        url: location.href,
        notes
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

      listEl.innerHTML = highlights.map(h => `
        <div class="oc-sb-hl-item">
          <div class="oc-sb-hl-quote">"${escHtml(h.text.length > 120 ? h.text.slice(0, 120) + '…' : h.text)}"</div>
          ${h.latex ? `<div class="oc-sb-hl-latex"><code>${escHtml(h.latex)}</code></div>` : ''}
          ${h.comment ? `<div class="oc-sb-hl-comment">— ${escHtml(h.comment)}</div>` : ''}
        </div>
      `).join('');
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

      // Render shared highlights with distinct styling
      highlights.forEach(h => {
        // Assign a temporary shared-specific ID so they don't collide with user's own
        const sharedH = { ...h, id: 'shared-' + (h.id || crypto.randomUUID()), _shared: true };
        injectSharedHighlight(sharedH);
      });
    } catch (e) {
      // Silently fail — don't disrupt page if fetch fails
    }
  }

  function injectSharedHighlight(h) {
    // Reuse existing highlight injection logic
    if (h.anchor) {
      const range = restoreFromAnchor(h.anchor, h.text);
      if (range) { wrapRangeShared(range, h); return; }
    }

    // Fallback: text search
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

    let origIdx = mapNormalizedToOriginal(accumulated, idx);
    let origEnd = mapNormalizedToOriginal(accumulated, idx + normalizedTarget.length);

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
    wrapRangeShared(range, h);
  }

  function wrapRangeShared(range, h) {
    try {
      const mark = document.createElement('mark');
      mark.className = 'oc-highlight-shared' + (h.comment ? ' oc-highlight-shared-comment' : '');
      mark.dataset.ocId = h.id;
      range.surroundContents(mark);
      mark.addEventListener('click', e => {
        e.stopPropagation();
        showSharedNoteBubble(mark, h);
      });
      return mark;
    } catch {
      return wrapRangeSharedMulti(range, h);
    }
  }

  function wrapRangeSharedMulti(range, h) {
    const textNodes = [];
    const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (range.intersectsNode(node)) textNodes.push(node);
    }
    if (!textNodes.length) return null;

    let firstMark = null;
    for (const tNode of textNodes) {
      let start = 0, end = tNode.nodeValue.length;
      if (tNode === range.startContainer) start = range.startOffset;
      if (tNode === range.endContainer) end = range.endOffset;
      if (start >= end) continue;

      if (end < tNode.nodeValue.length) tNode.splitText(end);
      const target = start > 0 ? tNode.splitText(start) : tNode;

      const mark = document.createElement('mark');
      mark.className = 'oc-highlight-shared' + (h.comment ? ' oc-highlight-shared-comment' : '');
      mark.dataset.ocId = h.id;
      target.parentNode.insertBefore(mark, target);
      mark.appendChild(target);
      mark.addEventListener('click', e => {
        e.stopPropagation();
        showSharedNoteBubble(mark, h);
      });
      if (!firstMark) firstMark = mark;
    }
    return firstMark;
  }

  function showSharedNoteBubble(anchor, h) {
    removeNoteBubble();
    noteBubble = document.createElement('div');
    noteBubble.id = 'oc-note-bubble';
    noteBubble.innerHTML = `
      <div class="oc-nb-quote">${escHtml(h.text.length > 120 ? h.text.slice(0, 120) + '\u2026' : h.text)}</div>
      ${h.latex ? `<div class="oc-nb-latex"><code>${escHtml(h.latex)}</code></div>` : ''}
      ${h.comment ? `<div class="oc-nb-comment">${escHtml(h.comment)}</div>` : ''}
      <div style="margin-top:6px; padding-top:6px; border-top:1px solid #222; font-size:10px; color:#555;">Shared annotation (read-only)</div>
    `;
    document.body.appendChild(noteBubble);

    const rect = anchor.getBoundingClientRect();
    let nx = rect.left + window.scrollX;
    let ny = rect.bottom + window.scrollY + 8;
    nx = Math.max(8, Math.min(nx, window.innerWidth - 270));
    noteBubble.style.left = nx + 'px';
    noteBubble.style.top = ny + 'px';
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
      document.querySelectorAll('.oc-highlight-shared').forEach(mark => {
        const parent = mark.parentNode;
        while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
        parent.removeChild(mark);
        parent.normalize();
      });
      // Clean the hash
      history.replaceState(null, '', location.pathname + location.search);
    });
  }

  // Apply on load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      applyStoredHighlights();
      const shareCode = getShareCodeFromHash();
      if (shareCode) loadSharedHighlights(shareCode);
    });
  } else {
    applyStoredHighlights();
    const shareCode = getShareCodeFromHash();
    if (shareCode) loadSharedHighlights(shareCode);
  }
})();

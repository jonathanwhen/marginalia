import * as pdfjsLib from './lib/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.mjs');

// ── State ───────────────────────────────────────────────────────────
let pdfDoc = null;
let currentScale = 1.5;
let currentPageKey = null;
let currentPdfUrl = null;
let currentFileName = null;
let pageContainers = [];  // { container, canvas, textLayer, rendered, pageIndex, rendering, renderTask }
let highlights = [];
let sidebarSaveTimer = null;
const SCALE_STEP = 0.25;
const MIN_SCALE = 0.5;
const MAX_SCALE = 4.0;
const RENDER_BUFFER = 2; // pages above/below viewport to pre-render

// ── DOM refs ────────────────────────────────────────────────────────
const viewer = document.getElementById('viewer');
const viewerContainer = document.getElementById('viewer-container');
const emptyState = document.getElementById('empty-state');
const statusText = document.getElementById('status-text');
const zoomLevel = document.getElementById('zoom-level');
const toolbarTitle = document.getElementById('toolbar-title');
const urlInput = document.getElementById('url-input');
const fileInput = document.getElementById('file-input');
const sidebar = document.getElementById('sidebar');
const hlToolbar = document.getElementById('hl-toolbar');
const annPopup = document.getElementById('ann-popup');
const annInput = document.getElementById('ann-input');
const noteBubble = document.getElementById('note-bubble');
const dropOverlay = document.getElementById('drop-overlay');

// ── Init from URL params ────────────────────────────────────────────
const params = new URLSearchParams(location.search);
const initUrl = params.get('url');
if (initUrl) {
  urlInput.value = initUrl;
  loadFromUrl(initUrl);
}

// ── Toolbar button handlers ─────────────────────────────────────────
document.getElementById('btn-upload').addEventListener('click', () => fileInput.click());
document.getElementById('empty-upload').addEventListener('click', () => fileInput.click());
document.getElementById('btn-load-url').addEventListener('click', () => {
  const url = urlInput.value.trim();
  if (url) loadFromUrl(url);
});
urlInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const url = urlInput.value.trim();
    if (url) loadFromUrl(url);
  }
});

document.getElementById('btn-zoom-in').addEventListener('click', () => setZoom(currentScale + SCALE_STEP));
document.getElementById('btn-zoom-out').addEventListener('click', () => setZoom(currentScale - SCALE_STEP));
document.getElementById('btn-sidebar').addEventListener('click', toggleSidebar);
document.getElementById('sb-close').addEventListener('click', toggleSidebar);

fileInput.addEventListener('change', e => {
  const file = e.target.files[0];
  if (file) loadFromFile(file);
  fileInput.value = '';
});

// ── Drag and drop ───────────────────────────────────────────────────
let dragCounter = 0;
document.addEventListener('dragenter', e => {
  e.preventDefault();
  dragCounter++;
  if (dragCounter === 1) dropOverlay.classList.remove('hidden');
});
document.addEventListener('dragleave', e => {
  e.preventDefault();
  dragCounter--;
  if (dragCounter === 0) dropOverlay.classList.add('hidden');
});
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => {
  e.preventDefault();
  dragCounter = 0;
  dropOverlay.classList.add('hidden');
  const file = e.dataTransfer.files[0];
  if (file && file.type === 'application/pdf') loadFromFile(file);
});

// ── Fetch PDF data via background service worker (bypasses CORS) ────
async function fetchPdfData(url) {
  // Extension pages don't inherit host_permissions for fetch/XHR.
  // Try direct fetch first (works for CORS-enabled servers like arxiv),
  // then fall back to proxying through the background service worker.
  try {
    const resp = await fetch(url);
    if (resp.ok) return await resp.arrayBuffer();
  } catch {}

  // Proxy through background — background has full host_permissions
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'oc-fetch-pdf', url }, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (response?.error) {
        reject(new Error(response.error));
        return;
      }
      if (response?.data) {
        // response.data is a base64 string; decode to ArrayBuffer
        const binary = atob(response.data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        resolve(bytes.buffer);
      } else {
        reject(new Error('No data received from background'));
      }
    });
  });
}

// ── Load PDF from URL ───────────────────────────────────────────────
async function loadFromUrl(url) {
  currentPdfUrl = url;
  currentFileName = null;
  // Derive pageKey from URL (same pattern as content.js / background.js)
  try {
    const u = new URL(url);
    currentPageKey = u.origin + u.pathname;
  } catch {
    currentPageKey = url;
  }

  statusText.textContent = 'Loading...';
  try {
    const data = await fetchPdfData(url);
    const doc = await pdfjsLib.getDocument({ data }).promise;
    await renderDocument(doc);
  } catch (err) {
    statusText.textContent = `Error: ${err.message}`;
  }
}

// ── Load PDF from File ──────────────────────────────────────────────
async function loadFromFile(file) {
  currentPdfUrl = null;
  currentFileName = file.name;

  statusText.textContent = 'Loading...';
  try {
    const arrayBuffer = await file.arrayBuffer();
    // Content-hash pageKey: sha256 prefix of first 64KB + filesize + filename
    const hashData = arrayBuffer.slice(0, 65536);
    const hashBuffer = await crypto.subtle.digest('SHA-256', hashData);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
    currentPageKey = `pdf-local:${hashHex}-${arrayBuffer.byteLength}-${file.name}`;

    const doc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    await renderDocument(doc);
  } catch (err) {
    statusText.textContent = `Error: ${err.message}`;
  }
}

// ── Render document ─────────────────────────────────────────────────
async function renderDocument(doc) {
  pdfDoc = doc;
  const numPages = doc.numPages;

  // Update UI
  emptyState?.remove();
  toolbarTitle.textContent = currentFileName || currentPdfUrl || '';
  document.title = `Marginalia Reader \u2014 ${currentFileName || currentPdfUrl || 'PDF'}`;
  statusText.textContent = `Page 1 of ${numPages}`;

  // Clear existing pages
  pageContainers.forEach(p => p.container.remove());
  pageContainers = [];

  // Load highlights for this document
  await loadHighlights();

  // Get first page to determine default dimensions, then create all placeholders
  // Uses first-page size for all placeholders to avoid loading every page upfront.
  // Pages with different sizes will be corrected when actually rendered.
  const firstPage = await doc.getPage(1);
  const defaultViewport = firstPage.getViewport({ scale: currentScale });

  for (let i = 0; i < numPages; i++) {
    const container = document.createElement('div');
    container.className = 'page-container';
    container.style.width = defaultViewport.width + 'px';
    container.style.height = defaultViewport.height + 'px';
    container.dataset.pageIndex = i;

    const canvas = document.createElement('canvas');
    container.appendChild(canvas);

    const textLayerDiv = document.createElement('div');
    textLayerDiv.className = 'textLayer';
    container.appendChild(textLayerDiv);

    viewer.appendChild(container);
    pageContainers.push({
      container, canvas, textLayer: textLayerDiv,
      rendered: false, pageIndex: i, rendering: false, renderTask: null
    });
  }

  // Observe which pages are visible for lazy rendering
  setupIntersectionObserver();

  // Register reading with background
  ensureReadingExists(numPages);

  // Open sidebar by default
  if (sidebar.classList.contains('hidden')) toggleSidebar();

  // Load sidebar content
  loadSidebarNotes();
  refreshSidebarHighlights();
}

// ── Lazy rendering via IntersectionObserver ──────────────────────────
let observer = null;

function setupIntersectionObserver() {
  if (observer) observer.disconnect();

  observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const idx = parseInt(entry.target.dataset.pageIndex);
      if (entry.isIntersecting) {
        // Render this page and buffer pages around it
        for (let i = Math.max(0, idx - RENDER_BUFFER); i <= Math.min(pageContainers.length - 1, idx + RENDER_BUFFER); i++) {
          renderPage(i);
        }
      }
    }
    updateCurrentPage();
  }, {
    root: viewerContainer,
    rootMargin: '200px 0px'
  });

  pageContainers.forEach(p => observer.observe(p.container));
}

// ── Render a single page ────────────────────────────────────────────
async function renderPage(pageIndex) {
  const pc = pageContainers[pageIndex];
  if (!pc || pc.rendered || pc.rendering) return;
  pc.rendering = true;

  try {
    const page = await pdfDoc.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: currentScale });

    // Update container size to match actual page dimensions (may differ from default)
    pc.container.style.width = viewport.width + 'px';
    pc.container.style.height = viewport.height + 'px';

    // Canvas rendering
    const canvas = pc.canvas;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = viewport.width * dpr;
    canvas.height = viewport.height * dpr;
    canvas.style.width = viewport.width + 'px';
    canvas.style.height = viewport.height + 'px';
    ctx.scale(dpr, dpr);

    const renderTask = page.render({ canvasContext: ctx, viewport });
    pc.renderTask = renderTask;
    await renderTask.promise;

    // Text layer — use PDF.js TextLayer for correct positioning
    pc.textLayer.innerHTML = '';
    // TextLayer requires --scale-factor CSS variable on the container
    pc.textLayer.style.setProperty('--scale-factor', currentScale);

    const textLayer = new pdfjsLib.TextLayer({
      textContentSource: page.streamTextContent(),
      container: pc.textLayer,
      viewport,
    });
    await textLayer.render();

    pc.rendered = true;
    pc.renderTask = null;

    // Apply highlights to this page
    applyHighlightsToPage(pageIndex);
  } catch (err) {
    if (err.name === 'RenderingCancelledException') return; // expected on zoom
    console.error(`Error rendering page ${pageIndex + 1}:`, err);
  } finally {
    pc.rendering = false;
  }
}

// ── Zoom ────────────────────────────────────────────────────────────
function setZoom(newScale) {
  newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, newScale));
  if (newScale === currentScale) return;

  // Remember scroll position as fraction
  const scrollFraction = viewerContainer.scrollTop / (viewerContainer.scrollHeight || 1);

  currentScale = newScale;
  zoomLevel.textContent = Math.round(currentScale * 100) + '%';

  // Re-render all pages at new scale
  reRenderAllPages().then(() => {
    // Restore scroll position
    viewerContainer.scrollTop = scrollFraction * viewerContainer.scrollHeight;
  });
}

async function reRenderAllPages() {
  if (!pdfDoc) return;

  // Use first page to get new default viewport size
  const firstPage = await pdfDoc.getPage(1);
  const viewport = firstPage.getViewport({ scale: currentScale });

  for (const pc of pageContainers) {
    // Cancel any in-progress render
    if (pc.renderTask) {
      try { pc.renderTask.cancel(); } catch {}
      pc.renderTask = null;
    }
    pc.container.style.width = viewport.width + 'px';
    pc.container.style.height = viewport.height + 'px';
    pc.rendered = false;
    pc.rendering = false;
    pc.canvas.width = 0;
    pc.canvas.height = 0;
    pc.textLayer.innerHTML = '';
  }

  // Re-setup observer to trigger visible page rendering
  setupIntersectionObserver();
}

// ── Page tracking ───────────────────────────────────────────────────
function updateCurrentPage() {
  if (!pdfDoc) return;
  const containerRect = viewerContainer.getBoundingClientRect();
  const midY = containerRect.top + containerRect.height / 2;

  for (const pc of pageContainers) {
    const rect = pc.container.getBoundingClientRect();
    if (rect.top <= midY && rect.bottom >= midY) {
      statusText.textContent = `Page ${pc.pageIndex + 1} of ${pdfDoc.numPages}`;
      return;
    }
  }
}

viewerContainer.addEventListener('scroll', () => {
  updateCurrentPage();
});

// ── Storage helpers ─────────────────────────────────────────────────
function isContextValid() {
  try { return !!chrome.runtime?.id; } catch { return false; }
}

async function loadHighlights() {
  if (!currentPageKey || !isContextValid()) { highlights = []; return; }
  try {
    const result = await chrome.storage.local.get([currentPageKey]);
    const stored = result[currentPageKey];
    if (Array.isArray(stored)) {
      highlights = stored.filter(h =>
        h && typeof h.id === 'string' && typeof h.text === 'string' &&
        typeof h.pageIndex === 'number'
      );
      if (highlights.length < stored.length) {
        await chrome.storage.local.set({ [currentPageKey]: highlights });
      }
    } else {
      highlights = [];
    }
  } catch {
    highlights = [];
  }
}

async function saveHighlightsToStorage() {
  if (!currentPageKey || !isContextValid()) return;
  try {
    await chrome.storage.local.set({ [currentPageKey]: highlights });
  } catch {}
}

// Top-level text elements in the layer that contribute to the page's
// flat text string. Used by both selection-offset computation AND highlight
// application so the indexing matches.
function getTopLevelTextElements(textLayer) {
  return Array.from(textLayer.querySelectorAll(':scope > span:not(.oc-highlight), :scope > mark'));
}

// ── Highlight application on rendered pages ─────────────────────────
function applyHighlightsToPage(pageIndex) {
  const pc = pageContainers[pageIndex];
  if (!pc || !pc.rendered) return;

  const pageHighlights = highlights.filter(h => h.pageIndex === pageIndex);
  if (!pageHighlights.length) return;

  const spans = getTopLevelTextElements(pc.textLayer);
  if (!spans.length) return;

  const totalTextLen = spans.reduce((sum, s) => sum + s.textContent.length, 0);

  for (const h of pageHighlights) {
    if (h.startOffset !== undefined && h.endOffset !== undefined) {
      const hlLen = h.endOffset - h.startOffset;
      if (hlLen > totalTextLen * 0.8) {
        console.warn(`[Marginalia] Skipping bad highlight: covers ${hlLen}/${totalTextLen} chars on page ${pageIndex}`);
        continue;
      }
    }
    applyHighlightToTextLayer(spans, h);
  }
}

// Apply a single new highlight to an already-rendered page without re-rendering.
function applyHighlightIncremental(pageIndex, h) {
  const pc = pageContainers[pageIndex];
  if (!pc || !pc.rendered) return false;
  const spans = getTopLevelTextElements(pc.textLayer);
  if (!spans.length) return false;
  const before = pc.textLayer.querySelectorAll(`mark[data-oc-id="${CSS.escape(h.id)}"]`).length;
  applyHighlightToTextLayer(spans, h);
  const after = pc.textLayer.querySelectorAll(`mark[data-oc-id="${CSS.escape(h.id)}"]`).length;
  return after > before;
}

function applyHighlightToTextLayer(allSpans, h) {
  if (h.startOffset !== undefined && h.endOffset !== undefined && h.endOffset > h.startOffset) {
    const result = findSpansByOffset(allSpans, h.startOffset, h.endOffset);
    if (result.length > 0) {
      wrapSpansAsHighlight(result, h);
      return;
    }
  }

  const allText = allSpans.map(s => s.textContent).join('');
  const searchText = h.text;
  if (!searchText) return;

  let idx = allText.indexOf(searchText);
  let matchLen = searchText.length;

  if (idx === -1) {
    const normSearch = searchText.replace(/\s+/g, ' ').trim();
    if (normSearch) {
      const orig = allText;
      let collapsed = '';
      const map = [];
      let prevWs = false;
      for (let i = 0; i < orig.length; i++) {
        const ch = orig[i];
        const isWs = /\s/.test(ch);
        if (isWs) {
          if (!prevWs && collapsed.length > 0) { collapsed += ' '; map.push(i); }
          prevWs = true;
        } else {
          collapsed += ch;
          map.push(i);
          prevWs = false;
        }
      }
      const cIdx = collapsed.indexOf(normSearch);
      if (cIdx !== -1) {
        idx = map[cIdx];
        const endC = cIdx + normSearch.length - 1;
        const origEnd = (map[endC] ?? idx + matchLen) + 1;
        matchLen = origEnd - idx;
      }
    }
  }

  if (idx === -1) return;
  const result = findSpansByOffset(allSpans, idx, idx + matchLen);
  if (result.length > 0) {
    wrapSpansAsHighlight(result, h);
  }
}

// Given a flat char offset range, find which spans (and partial offsets within them) to highlight
function findSpansByOffset(spans, startOffset, endOffset) {
  const results = []; // { span, start, end } — char offsets within the span
  let pos = 0;
  for (const span of spans) {
    const len = span.textContent.length;
    const spanEnd = pos + len;
    if (spanEnd <= startOffset) { pos = spanEnd; continue; }
    if (pos >= endOffset) break;

    const s = Math.max(0, startOffset - pos);
    const e = Math.min(len, endOffset - pos);
    if (e > s) results.push({ span, start: s, end: e });
    pos = spanEnd;
  }
  return results;
}

function wrapSpansAsHighlight(spanRanges, h) {
  for (const { span, start, end } of spanRanges) {
    const text = span.textContent;
    if (start === 0 && end === text.length) {
      // Whole span — wrap directly
      const mark = createMark(h);
      mark.textContent = text;
      // Copy positioning styles from the span
      copySpanStyles(span, mark);
      span.parentNode.replaceChild(mark, span);
    } else {
      // Partial span — wrap text inline within the span using Range.
      // Avoids splitting into multiple absolute-positioned elements at the
      // same coordinates, which renders as overlapping horizontal bars.
      const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
      let tNode, charPos = 0;
      let startNode = null, startOff = 0, endNode = null, endOff = 0;

      while ((tNode = walker.nextNode())) {
        const len = tNode.length;
        if (startNode === null && charPos + len > start) {
          startNode = tNode;
          startOff = start - charPos;
        }
        if (charPos + len >= end) {
          endNode = tNode;
          endOff = end - charPos;
          break;
        }
        charPos += len;
      }

      if (!startNode || !endNode) continue;

      if (startNode === endNode) {
        // Single text node: use surroundContents
        const range = document.createRange();
        range.setStart(startNode, startOff);
        range.setEnd(endNode, endOff);

        const mark = createInlineMark(h);
        range.surroundContents(mark);
      } else {
        // Multi-node: wrap each text node portion individually
        const walker2 = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
        let tNode2, inRange = false;
        const toWrap = [];
        while ((tNode2 = walker2.nextNode())) {
          if (tNode2 === startNode) { inRange = true; toWrap.push({ node: tNode2, s: startOff, e: tNode2.length }); continue; }
          if (inRange && tNode2 !== endNode) { toWrap.push({ node: tNode2, s: 0, e: tNode2.length }); continue; }
          if (tNode2 === endNode) { toWrap.push({ node: tNode2, s: 0, e: endOff }); break; }
        }
        for (const { node: wNode, s: ws, e: we } of toWrap) {
          if (ws >= we) continue;
          const r = document.createRange();
          r.setStart(wNode, ws);
          r.setEnd(wNode, we);
          const mark = createInlineMark(h);
          r.surroundContents(mark);
        }
      }
    }
  }
}

function copySpanStyles(from, to) {
  // Copy only positioning-related inline styles that PDF.js TextLayer sets
  const cs = from.style;
  if (cs.left) to.style.left = cs.left;
  if (cs.top) to.style.top = cs.top;
  if (cs.fontSize) to.style.fontSize = cs.fontSize;
  if (cs.fontFamily) to.style.fontFamily = cs.fontFamily;
  if (cs.transform) to.style.transform = cs.transform;
  if (cs.transformOrigin) to.style.transformOrigin = cs.transformOrigin;
  if (cs.width) to.style.width = cs.width;
}

function createMark(h) {
  const mark = document.createElement('mark');
  mark.className = 'oc-highlight' + (h.comment ? ' oc-highlight-comment' : '');
  mark.dataset.ocId = h.id;
  mark.style.color = 'transparent';
  mark.style.position = 'absolute';
  mark.style.whiteSpace = 'pre';
  mark.addEventListener('click', e => {
    e.stopPropagation();
    showNoteBubble(e, h);
  });
  return mark;
}

// Inline mark for partial-span highlights (nested inside the span, no positioning)
function createInlineMark(h) {
  const mark = document.createElement('mark');
  mark.className = 'oc-highlight' + (h.comment ? ' oc-highlight-comment' : '');
  mark.dataset.ocId = h.id;
  mark.addEventListener('click', e => {
    e.stopPropagation();
    showNoteBubble(e, h);
  });
  return mark;
}

// ── Selection and highlighting ──────────────────────────────────────
let pendingHighlight = null;

viewerContainer.addEventListener('mouseup', e => {
  if (hlToolbar.contains(e.target) || annPopup.contains(e.target) || noteBubble.contains(e.target)) return;

  hideNoteBubble();

  setTimeout(() => {
    const sel = window.getSelection();
    const text = sel?.toString().trim();
    if (!text || text.length < 2) {
      hideHlToolbar();
      return;
    }

    // Determine which page container the selection starts in
    const anchorNode = sel.anchorNode;
    const pageContainer = anchorNode?.parentElement?.closest?.('.page-container');
    if (!pageContainer) { hideHlToolbar(); return; }

    const pageIndex = parseInt(pageContainer.dataset.pageIndex);
    const pc = pageContainers[pageIndex];
    if (!pc) { hideHlToolbar(); return; }

    const spans = getTopLevelTextElements(pc.textLayer);
    const { startOffset, endOffset } = computeSelectionOffsets(sel, spans);

    const selRect = sel.getRangeAt(0).getBoundingClientRect();
    pendingHighlight = { text, pageIndex, startOffset, endOffset, selRect };

    hlToolbar.style.left = Math.max(8, selRect.left + selRect.width / 2 - 80) + 'px';
    hlToolbar.style.top = Math.max(8, selRect.top - 40) + 'px';
    hlToolbar.classList.remove('hidden');
  }, 10);
});

document.addEventListener('mousedown', e => {
  if (!hlToolbar.contains(e.target) && !hlToolbar.classList.contains('hidden')) {
    hideHlToolbar();
  }
  if (!noteBubble.contains(e.target) && !noteBubble.classList.contains('hidden')) {
    hideNoteBubble();
  }
  if (!annPopup.contains(e.target) && !annPopup.classList.contains('hidden')) {
    hideAnnPopup();
  }
});

function computeSelectionOffsets(sel, spans) {
  // Build a map of char positions for each span/mark
  let totalOffset = 0;
  const nodeOffsets = new Map();
  for (const el of spans) {
    // el could be a span or a mark; walk its text nodes
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let tNode;
    while ((tNode = walker.nextNode())) {
      nodeOffsets.set(tNode, totalOffset);
      totalOffset += tNode.textContent.length;
    }
  }

  let startOffset = 0, endOffset = 0;
  const anchorOff = nodeOffsets.get(sel.anchorNode);
  const focusOff = nodeOffsets.get(sel.focusNode);

  if (anchorOff !== undefined) startOffset = anchorOff + sel.anchorOffset;
  if (focusOff !== undefined) endOffset = focusOff + sel.focusOffset;

  // Ensure start < end
  if (startOffset > endOffset) [startOffset, endOffset] = [endOffset, startOffset];

  return { startOffset, endOffset };
}

// ── Highlight toolbar actions ───────────────────────────────────────
document.getElementById('hl-btn-highlight').addEventListener('click', e => {
  e.stopPropagation();
  if (!pendingHighlight) return;
  createHighlight(pendingHighlight, '');
  hideHlToolbar();
  window.getSelection()?.removeAllRanges();
});

document.getElementById('hl-btn-comment').addEventListener('click', e => {
  e.stopPropagation();
  if (!pendingHighlight) return;
  const rect = pendingHighlight.selRect;
  const h = createHighlight(pendingHighlight, '');
  hideHlToolbar();
  window.getSelection()?.removeAllRanges();
  if (h) showAnnotationPopup(h, rect);
});

function createHighlight(pending, comment) {
  const pc = pageContainers[pending.pageIndex];
  const spans = pc ? getTopLevelTextElements(pc.textLayer) : [];
  const latex = reconstructMathText(spans, pending.startOffset, pending.endOffset);

  const h = {
    id: crypto.randomUUID(),
    text: pending.text.slice(0, 300),
    comment,
    timestamp: new Date().toISOString(),
    pageIndex: pending.pageIndex,
    startOffset: pending.startOffset,
    endOffset: pending.endOffset,
    ...(latex ? { latex } : {})
  };

  highlights.push(h);
  saveHighlightsToStorage();
  ensureReadingExists();
  notifyHighlightChanged('create', h.text, h.id);

  applyHighlightIncremental(pending.pageIndex, h);
  refreshSidebarHighlights();

  return h;
}

function unwrapHighlightMarks(id, pageIndex) {
  const pc = pageContainers[pageIndex];
  if (!pc) return;
  const marks = pc.textLayer.querySelectorAll(`mark[data-oc-id="${CSS.escape(id)}"]`);
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    if (parent.classList?.contains('textLayer')) {
      const span = document.createElement('span');
      span.textContent = mark.textContent;
      for (const prop of ['left', 'top', 'fontSize', 'fontFamily', 'transform', 'transformOrigin', 'width']) {
        if (mark.style[prop]) span.style[prop] = mark.style[prop];
      }
      parent.replaceChild(span, mark);
    } else {
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parent.normalize();
    }
  }
}

// ── Annotation popup ────────────────────────────────────────────────
function showAnnotationPopup(h, fallbackRect) {
  const mark = document.querySelector(`mark[data-oc-id="${CSS.escape(h.id)}"]`);
  const rect = mark ? mark.getBoundingClientRect() : fallbackRect;
  if (!rect) return;

  annPopup.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 290)) + 'px';
  annPopup.style.top = (rect.bottom + 4) + 'px';
  annPopup.classList.remove('hidden');
  annInput.value = '';
  setTimeout(() => annInput.focus(), 0);

  annInput.onkeydown = e => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      const comment = annInput.value.trim();
      if (comment) updateHighlightComment(h.id, comment);
      hideAnnPopup();
    }
    if (e.key === 'Escape') hideAnnPopup();
  };
}

// ── Note bubble ─────────────────────────────────────────────────────
function showNoteBubble(event, h) {
  hideNoteBubble();
  hideHlToolbar();

  const hasComment = !!h.comment;
  noteBubble.innerHTML = `
    <div class="nb-quote">${escHtml(h.text.length > 120 ? h.text.slice(0, 120) + '\u2026' : h.text)}</div>
    ${h.latex ? `<div class="nb-latex"><code>${escHtml(h.latex)}</code></div>` : ''}
    ${hasComment ? `<div class="nb-comment">${escHtml(h.comment)}</div>` : ''}
    <div class="nb-edit-section" style="display:none;">
      <textarea class="nb-edit-input" placeholder="Add a note...">${escHtml(h.comment || '')}</textarea>
      <div class="nb-edit-actions">
        <button class="nb-edit-save">Save</button>
        <button class="nb-edit-cancel">Cancel</button>
      </div>
    </div>
    <div class="nb-actions">
      <span class="nb-edit-btn">${hasComment ? '\u270E Edit note' : '\u270E Add note'}</span>
      <span class="nb-delete">\u2715 Remove</span>
    </div>
  `;

  const x = Math.max(8, Math.min(event.clientX - 30, window.innerWidth - 300));
  const y = event.clientY + 10;
  noteBubble.style.left = x + 'px';
  noteBubble.style.top = y + 'px';
  noteBubble.classList.remove('hidden');

  // Delete
  noteBubble.querySelector('.nb-delete').addEventListener('click', () => {
    deleteHighlight(h.id);
    hideNoteBubble();
  });

  // Edit
  const editSection = noteBubble.querySelector('.nb-edit-section');
  const editInput = noteBubble.querySelector('.nb-edit-input');
  const commentDiv = noteBubble.querySelector('.nb-comment');
  const actionsDiv = noteBubble.querySelector('.nb-actions');

  noteBubble.querySelector('.nb-edit-btn').addEventListener('click', () => {
    editSection.style.display = 'block';
    actionsDiv.style.display = 'none';
    if (commentDiv) commentDiv.style.display = 'none';
    editInput.focus();
    editInput.setSelectionRange(editInput.value.length, editInput.value.length);
  });

  noteBubble.querySelector('.nb-edit-save').addEventListener('click', () => {
    updateHighlightComment(h.id, editInput.value.trim());
    hideNoteBubble();
  });

  noteBubble.querySelector('.nb-edit-cancel').addEventListener('click', () => {
    editSection.style.display = 'none';
    actionsDiv.style.display = '';
    if (commentDiv) commentDiv.style.display = '';
  });

  editInput.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      noteBubble.querySelector('.nb-edit-save').click();
    }
    if (e.key === 'Escape') {
      noteBubble.querySelector('.nb-edit-cancel').click();
    }
  });
}

// ── Highlight CRUD ──────────────────────────────────────────────────
function updateHighlightComment(id, comment) {
  const h = highlights.find(hl => hl.id === id);
  if (!h) return;
  h.comment = comment;
  saveHighlightsToStorage();
  notifyHighlightChanged('update', h.text, h.id);

  const marks = document.querySelectorAll(`mark[data-oc-id="${CSS.escape(id)}"]`);
  for (const m of marks) m.classList.toggle('oc-highlight-comment', !!comment);
  refreshSidebarHighlights();
}

function deleteHighlight(id) {
  const h = highlights.find(hl => hl.id === id);
  if (!h) return;
  highlights = highlights.filter(hl => hl.id !== id);
  saveHighlightsToStorage();
  notifyHighlightChanged('delete', '', id);
  unwrapHighlightMarks(id, h.pageIndex);
  refreshSidebarHighlights();
}

// ── Hide helpers ────────────────────────────────────────────────────
function hideHlToolbar() { hlToolbar.classList.add('hidden'); }
function hideAnnPopup() { annPopup.classList.add('hidden'); annInput.onkeydown = null; }
function hideNoteBubble() { noteBubble.classList.add('hidden'); }

// ── Sidebar ─────────────────────────────────────────────────────────
function toggleSidebar() {
  const btn = document.getElementById('btn-sidebar');
  if (sidebar.classList.contains('hidden')) {
    sidebar.classList.remove('hidden');
    btn.classList.add('active');
    loadSidebarNotes();
    refreshSidebarHighlights();
  } else {
    // Flush pending note save before closing
    if (sidebarSaveTimer) {
      clearTimeout(sidebarSaveTimer);
      sidebarSaveTimer = null;
      saveSidebarNote();
    }
    sidebar.classList.add('hidden');
    btn.classList.remove('active');
  }
}

function loadSidebarNotes() {
  if (!currentPageKey || !isContextValid()) return;
  try {
    chrome.runtime.sendMessage({ type: 'oc-get-reading', pageKey: currentPageKey }, response => {
      if (response?.reading?.notes) {
        document.getElementById('sb-notes').value = response.reading.notes;
      }
    });
  } catch {}
}

function saveSidebarNote() {
  const notes = document.getElementById('sb-notes').value.trim();
  const statusEl = document.getElementById('sb-status');
  if (!currentPageKey || !isContextValid()) return;

  try {
    chrome.runtime.sendMessage({
      type: 'oc-upsert-reading',
      pageKey: currentPageKey,
      title: currentFileName || currentPdfUrl || currentPageKey,
      url: currentPdfUrl || currentPageKey,
      notes
    }, result => {
      if (result?.ok) {
        statusEl.textContent = 'Saved';
        statusEl.className = 'sb-status saved';
        setTimeout(() => {
          if (statusEl.textContent === 'Saved') {
            statusEl.textContent = '';
            statusEl.className = 'sb-status';
          }
        }, 2000);
      }
    });
  } catch {}
}

// Notes auto-save
document.getElementById('sb-notes').addEventListener('input', () => {
  const statusEl = document.getElementById('sb-status');
  statusEl.textContent = '';
  statusEl.className = 'sb-status';
  clearTimeout(sidebarSaveTimer);
  sidebarSaveTimer = setTimeout(() => saveSidebarNote(), 1000);
});

document.getElementById('sb-notes').addEventListener('keydown', e => {
  if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    clearTimeout(sidebarSaveTimer);
    saveSidebarNote();
  }
});

function refreshSidebarHighlights() {
  const header = document.getElementById('sb-hl-header');
  const list = document.getElementById('sb-hl-list');
  if (!header || !list) return;

  header.textContent = `Highlights (${highlights.length})`;

  if (!highlights.length) {
    list.innerHTML = '<div class="sb-hl-empty">No highlights yet.</div>';
    return;
  }

  list.innerHTML = highlights.map(h => `
    <div class="sb-hl-item" data-hl-id="${escAttr(h.id)}" data-page="${h.pageIndex}">
      <div class="sb-hl-quote">"${escHtml(h.text.length > 120 ? h.text.slice(0, 120) + '\u2026' : h.text)}"</div>
      ${h.latex ? `<div class="sb-hl-latex"><code>${escHtml(h.latex)}</code></div>` : ''}
      ${h.comment ? `<div class="sb-hl-comment">\u2014 ${escHtml(h.comment)}</div>` : ''}
      <div class="sb-hl-page">Page ${h.pageIndex + 1}</div>
    </div>
  `).join('');

  // Click to scroll to highlight
  list.querySelectorAll('.sb-hl-item').forEach(item => {
    item.addEventListener('click', () => {
      const pageIdx = parseInt(item.dataset.page);
      scrollToPage(pageIdx);
    });
  });
}

function scrollToPage(pageIndex) {
  const pc = pageContainers[pageIndex];
  if (!pc) return;
  pc.container.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ── Background communication ────────────────────────────────────────
function ensureReadingExists(numPages) {
  if (!currentPageKey || !isContextValid()) return;
  try {
    chrome.runtime.sendMessage({
      type: 'oc-upsert-reading',
      pageKey: currentPageKey,
      title: currentFileName || currentPdfUrl || currentPageKey,
      url: currentPdfUrl || currentPageKey,
      estPages: numPages || pdfDoc?.numPages || 0
    });
  } catch {}
}

function notifyHighlightChanged(action, text, highlightId) {
  if (!currentPageKey || !isContextValid()) return;
  try {
    chrome.runtime.sendMessage({
      type: 'oc-highlight-changed',
      pageKey: currentPageKey,
      action,
      text,
      highlightId
    });
  } catch {}
}

// ── Keyboard shortcuts ──────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    hideHlToolbar();
    hideAnnPopup();
    hideNoteBubble();
  }
  // Zoom with Ctrl/Cmd +/-
  if ((e.metaKey || e.ctrlKey) && (e.key === '=' || e.key === '+')) {
    e.preventDefault();
    setZoom(currentScale + SCALE_STEP);
  }
  if ((e.metaKey || e.ctrlKey) && e.key === '-') {
    e.preventDefault();
    setZoom(currentScale - SCALE_STEP);
  }
  if ((e.metaKey || e.ctrlKey) && e.key === '0') {
    e.preventDefault();
    setZoom(1.5);
  }
});

// ── Markdown + LaTeX rendering pipeline ──────────────────────────────
function renderMarkdownWithMath(text) {
  if (!text) return '';
  if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') return escHtml(text);

  let html = marked.parse(text);
  html = DOMPurify.sanitize(html);

  if (typeof katex !== 'undefined') {
    html = html.replace(/\$\$([\s\S]+?)\$\$/g, (_match, tex) => {
      try {
        return katex.renderToString(tex.trim(), { displayMode: true, throwOnError: false });
      } catch { return `<code>${escHtml(tex)}</code>`; }
    });
    html = html.replace(/(?<!\$)\$(?!\$)((?:[^$\\]|\\.)+?)\$/g, (_match, tex) => {
      try {
        return katex.renderToString(tex.trim(), { displayMode: false, throwOnError: false });
      } catch { return `<code>${escHtml(tex)}</code>`; }
    });
  }

  return html;
}

// ── Sidebar tab switching ────────────────────────────────────────────
document.querySelectorAll('.sb-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.sb-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');

    const editPane = document.getElementById('sb-edit-pane');
    const previewPane = document.getElementById('sb-preview-pane');

    if (tab.dataset.tab === 'preview') {
      editPane.classList.add('hidden');
      previewPane.classList.remove('hidden');
      const notes = document.getElementById('sb-notes').value;
      previewPane.innerHTML = renderMarkdownWithMath(notes) || '<div class="sb-preview-empty">Nothing to preview.</div>';
    } else {
      previewPane.classList.add('hidden');
      editPane.classList.remove('hidden');
      document.getElementById('sb-notes').focus();
    }
  });
});

// ── Math reconstruction from PDF text layer ──────────────────────────
const UNICODE_TO_LATEX = {
  '\u2211': '\\sum', '\u220F': '\\prod', '\u222B': '\\int', '\u221E': '\\infty',
  '\u2202': '\\partial', '\u2207': '\\nabla', '\u00D7': '\\times', '\u00F7': '\\div',
  '\u00B1': '\\pm', '\u2213': '\\mp', '\u2264': '\\leq', '\u2265': '\\geq',
  '\u2260': '\\neq', '\u2248': '\\approx', '\u221D': '\\propto', '\u2261': '\\equiv',
  '\u2208': '\\in', '\u2209': '\\notin', '\u2282': '\\subset', '\u2283': '\\supset',
  '\u2286': '\\subseteq', '\u2287': '\\supseteq', '\u222A': '\\cup', '\u2229': '\\cap',
  '\u2205': '\\emptyset', '\u2200': '\\forall', '\u2203': '\\exists',
  '\u00AC': '\\neg', '\u2227': '\\land', '\u2228': '\\lor',
  '\u2192': '\\to', '\u2190': '\\leftarrow', '\u21D2': '\\Rightarrow', '\u21D4': '\\Leftrightarrow',
  '\u03B1': '\\alpha', '\u03B2': '\\beta', '\u03B3': '\\gamma', '\u03B4': '\\delta',
  '\u03B5': '\\epsilon', '\u03B6': '\\zeta', '\u03B7': '\\eta', '\u03B8': '\\theta',
  '\u03B9': '\\iota', '\u03BA': '\\kappa', '\u03BB': '\\lambda', '\u03BC': '\\mu',
  '\u03BD': '\\nu', '\u03BE': '\\xi', '\u03C0': '\\pi', '\u03C1': '\\rho',
  '\u03C3': '\\sigma', '\u03C4': '\\tau', '\u03C5': '\\upsilon', '\u03C6': '\\phi',
  '\u03C7': '\\chi', '\u03C8': '\\psi', '\u03C9': '\\omega',
  '\u0393': '\\Gamma', '\u0394': '\\Delta', '\u0398': '\\Theta', '\u039B': '\\Lambda',
  '\u039E': '\\Xi', '\u03A0': '\\Pi', '\u03A3': '\\Sigma', '\u03A6': '\\Phi',
  '\u03A8': '\\Psi', '\u03A9': '\\Omega',
  '\u221A': '\\sqrt', '\u2026': '\\ldots', '\u22C5': '\\cdot', '\u2218': '\\circ',
  '\u2297': '\\otimes', '\u2295': '\\oplus', '\u22C6': '\\star',
};

function mapUnicodeToLatex(text) {
  let result = '';
  for (const ch of text) {
    result += UNICODE_TO_LATEX[ch] || ch;
  }
  return result;
}

function reconstructMathText(spans, startOffset, endOffset) {
  if (!spans.length) return null;

  let pos = 0;
  const rangeSpans = [];
  for (const span of spans) {
    const len = span.textContent.length;
    const spanEnd = pos + len;
    if (spanEnd <= startOffset) { pos = spanEnd; continue; }
    if (pos >= endOffset) break;
    rangeSpans.push(span);
    pos = spanEnd;
  }

  if (!rangeSpans.length) return null;

  const fullText = rangeSpans.map(s => s.textContent).join('');
  const hasMathChars = /[\u03B1-\u03C9\u0393-\u03A9\u2200-\u22FF\u221A\u222B\u2211\u220F\u2202\u2207]/.test(fullText);
  if (!hasMathChars) return null;

  let latex = '';
  let baseSize = null;

  for (const span of rangeSpans) {
    const style = span.style;
    const fontSize = parseFloat(style.fontSize) || null;
    const top = parseFloat(style.top) || 0;
    const text = span.textContent;

    if (baseSize === null && fontSize) baseSize = fontSize;

    const mapped = mapUnicodeToLatex(text);

    if (baseSize && fontSize && fontSize < baseSize * 0.8) {
      const prevSpan = rangeSpans[rangeSpans.indexOf(span) - 1];
      const prevTop = prevSpan ? (parseFloat(prevSpan.style.top) || 0) : top;

      if (top > prevTop) {
        latex += `_{${mapped}}`;
      } else {
        latex += `^{${mapped}}`;
      }
    } else {
      latex += mapped;
    }
  }

  if (latex === fullText) return null;
  return latex.trim() || null;
}

// ── Utility ─────────────────────────────────────────────────────────
function escHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;');
}

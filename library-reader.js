import * as pdfjsLib from './lib/pdf.min.mjs';
import { getTranscript, updateTranscriptField } from './lib/db.js';
import { shareAnnotations, getShareUrl, getCurrentUser } from './lib/supabase.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.mjs');

// ── State ───────────────────────────────────────────────────────────
let pdfDoc = null;
let currentScale = 1.5;
let currentPageKey = null;
let currentTitle = '';
let currentAuthor = '';
let pageContainers = [];
let highlights = [];
let highlightMode = false;
let activeColor = 'orange';
let sidebarSaveTimer = null;
let pendingHighlight = null;
let positionSaveTimer = null;

const SCALE_STEP = 0.25;
const MIN_SCALE = 0.5;
const MAX_SCALE = 4.0;
const RENDER_BUFFER = 2;

// Search state
let searchMatches = [];
let searchIndex = -1;
let pageTexts = null;

// ── DOM refs ────────────────────────────────────────────────────────
const viewer = document.getElementById('viewer');
const viewerContainer = document.getElementById('viewer-container');
const statusText = document.getElementById('status-text');
const zoomLevel = document.getElementById('zoom-level');
const toolbarTitle = document.getElementById('toolbar-title');
const sidebar = document.getElementById('sidebar');
const hlToolbar = document.getElementById('hl-toolbar');
const annPopup = document.getElementById('ann-popup');
const annInput = document.getElementById('ann-input');
const noteBubble = document.getElementById('note-bubble');
const modeBanner = document.getElementById('mode-banner');
const searchBar = document.getElementById('search-bar');
const searchInput = document.getElementById('search-input');
const searchCount = document.getElementById('search-count');
const toast = document.getElementById('toast');
const toolbarAuthor = document.getElementById('toolbar-author');
const metaEditPanel = document.getElementById('meta-edit-panel');
const metaTitleInput = document.getElementById('meta-title');
const metaAuthorInput = document.getElementById('meta-author');

// ── Color map for highlight rendering ────────────────────────────────
const HL_COLORS = {
  orange: 'rgba(232, 168, 124, 0.8)',
  green:  'rgba(111, 207, 151, 0.8)',
  blue:   'rgba(100, 181, 246, 0.8)',
  pink:   'rgba(240, 98, 146, 0.8)'
};

// ── Init ─────────────────────────────────────────────────────────────
const params = new URLSearchParams(location.search);
const pageKey = params.get('key');
const filePath = params.get('file');

if (filePath) {
  // Electron: load PDF from filesystem path
  currentPageKey = filePath;
  loadFilePdf(filePath);
} else if (pageKey) {
  currentPageKey = pageKey;
  loadLibraryPdf(pageKey);
}

// Debug helper: run __clearHighlights() in console to wipe stored highlights for current doc
window.__clearHighlights = async () => {
  if (!currentPageKey) return console.log('No page loaded');
  await chrome.storage.local.remove([currentPageKey]);
  highlights = [];
  console.log(`Cleared highlights for ${currentPageKey}`);
  location.reload();
};

// ── Toolbar handlers ─────────────────────────────────────────────────
document.getElementById('btn-zoom-in').addEventListener('click', () => setZoom(currentScale + SCALE_STEP));
document.getElementById('btn-zoom-out').addEventListener('click', () => setZoom(currentScale - SCALE_STEP));
document.getElementById('btn-sidebar').addEventListener('click', toggleSidebar);
document.getElementById('sb-close').addEventListener('click', toggleSidebar);
document.getElementById('btn-highlight-mode').addEventListener('click', () => {
  if (highlightMode) exitHighlightMode(); else enterHighlightMode();
});
document.getElementById('banner-exit').addEventListener('click', exitHighlightMode);
document.getElementById('btn-search').addEventListener('click', toggleSearch);
document.getElementById('btn-export').addEventListener('click', exportHighlightsAsMarkdown);
document.getElementById('btn-share').addEventListener('click', shareCurrentPage);
document.getElementById('btn-claude').addEventListener('click', async () => {
  if (!currentPageKey) return;

  const DEFAULT_PAPER_PROMPT = `I'm going to share an ML/AI paper with you. Your job is not to summarize it — it's to teach it to me in a way that builds genuine intuition and lasting mental models.

Start with a 3-5 sentence high-level orientation: what question the paper is trying to answer, why it matters, and the core finding in plain language. Don't try to cover everything here — just enough to orient me before we dive in.

Then, before diving in, read the full paper and decide how to chunk it into teaching sections. These don't have to match the paper's section headers — group or split however makes the most pedagogical sense for building understanding progressively. State explicitly how many sections you've settled on and list them out like a table of contents, so I know the shape of what we're walking through.

Then walk me through each section in order. For each one:
- Frame it as a continuation of the story: what question or gap is this section addressing given what we just covered?
- Explain the key ideas, findings, or methods in plain language first, then introduce any technical terms precisely — define them clearly when they first appear, and connect them to the intuition rather than leading with them
- Use analogies only when they genuinely clarify something that would otherwise be abstract — don't force them
- Flag the 1-3 things in this section I should actually hold onto as durable mental models vs. implementation details I can forget

After each section, pause and ask if I have questions or want to go deeper on anything before moving on. Don't proceed until I say so.

Throughout, explicitly call out:
- Results or findings that generalize beyond this paper — things that could reshape how I think about adjacent problems
- Anything that connects to or updates a prior established result in the field
- Any design choice, framing, or insight that's elegant or non-obvious in a way worth remembering

My goal is to finish with strong intuitions I can actually use, fluency with the technical vocabulary so future papers in this area become progressively easier to read on my own, and a handful of durable mental models worth carrying forward.`;

  const { claudeDiscussionPrompt } = await chrome.storage.local.get('claudeDiscussionPrompt');
  const template = claudeDiscussionPrompt || DEFAULT_PAPER_PROMPT;
  const header = currentAuthor ? `Paper: "${currentTitle}" by ${currentAuthor}` : `Paper: "${currentTitle}"`;
  const fullPrompt = `${header}\n\n${template}`;

  try {
    await navigator.clipboard.writeText(fullPrompt);
  } catch (e) {
    showToast('Failed to copy prompt');
    return;
  }

  await chrome.runtime.sendMessage({
    type: 'oc-open-claude-discussion',
    pageKey: currentPageKey
  });

  showToast('Prompt copied — paste in Claude');
});

// Color picker
document.querySelectorAll('.color-dot').forEach(dot => {
  dot.addEventListener('click', () => {
    document.querySelector('.color-dot.active')?.classList.remove('active');
    dot.classList.add('active');
    activeColor = dot.dataset.color;
  });
});

// Search bar
document.getElementById('search-close').addEventListener('click', closeSearch);
document.getElementById('search-prev').addEventListener('click', () => navigateSearch(-1));
document.getElementById('search-next').addEventListener('click', () => navigateSearch(1));
searchInput.addEventListener('input', () => {
  clearTimeout(searchInput._timer);
  searchInput._timer = setTimeout(() => performSearch(searchInput.value), 200);
});
searchInput.addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Enter') {
    e.preventDefault();
    navigateSearch(e.shiftKey ? -1 : 1);
  }
  if (e.key === 'Escape') closeSearch();
});

// ── Load PDF from IndexedDB ──────────────────────────────────────────
async function loadLibraryPdf(key) {
  const transcript = await getTranscript(key);
  if (!transcript) {
    statusText.textContent = 'Document not found.';
    return;
  }

  if (!transcript.pdfData) {
    statusText.textContent = 'This document needs to be re-imported (old format).';
    return;
  }

  currentTitle = transcript.title || '';
  currentAuthor = transcript.author || '';
  document.title = `Marginalia — ${currentTitle}`;
  toolbarTitle.textContent = currentTitle;
  toolbarAuthor.textContent = currentAuthor ? `by ${currentAuthor}` : '';

  const doc = await pdfjsLib.getDocument({ data: transcript.pdfData }).promise;
  await renderDocument(doc);
  restoreReadingPosition();
}

// ── Load PDF from filesystem (Electron) ──────────────────────────────
async function loadFilePdf(filePath) {
  try {
    const res = await fetch('file://' + filePath);
    if (!res.ok) throw new Error(`Failed to load file: ${res.status}`);
    const arrayBuffer = await res.arrayBuffer();

    const fileName = filePath.split('/').pop().split('\\').pop() || 'Untitled';
    currentTitle = fileName.replace(/\.pdf$/i, '');
    document.title = `Marginalia — ${currentTitle}`;
    toolbarTitle.textContent = currentTitle;

    const doc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    await renderDocument(doc);
    restoreReadingPosition();
  } catch (e) {
    statusText.textContent = `Failed to open PDF: ${e.message}`;
  }
}

// ── Render document ──────────────────────────────────────────────────
async function renderDocument(doc) {
  pdfDoc = doc;
  const numPages = doc.numPages;

  statusText.textContent = `Page 1 of ${numPages}`;

  // Clear existing pages
  pageContainers.forEach(p => p.container.remove());
  pageContainers = [];

  // Load highlights
  await loadHighlights();

  // Get first page for default dimensions
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

  setupIntersectionObserver();
  ensureReadingExists(numPages);

  // Open sidebar by default
  if (sidebar.classList.contains('hidden')) toggleSidebar();

  loadSidebarNotes();
  refreshSidebarHighlights();
}

// ── Lazy rendering via IntersectionObserver ───────────────────────────
let observer = null;

function setupIntersectionObserver() {
  if (observer) observer.disconnect();

  observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const idx = parseInt(entry.target.dataset.pageIndex);
      if (entry.isIntersecting) {
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

// ── Render a single page ─────────────────────────────────────────────
async function renderPage(pageIndex) {
  const pc = pageContainers[pageIndex];
  if (!pc || pc.rendered || pc.rendering) return;
  pc.rendering = true;

  try {
    const page = await pdfDoc.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: currentScale });

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

    // Text layer
    pc.textLayer.innerHTML = '';
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
    if (err.name === 'RenderingCancelledException') return;
    console.error(`Error rendering page ${pageIndex + 1}:`, err);
  } finally {
    pc.rendering = false;
  }
}

// ── Zoom ─────────────────────────────────────────────────────────────
function setZoom(newScale) {
  newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, newScale));
  if (newScale === currentScale) return;

  const scrollFraction = viewerContainer.scrollTop / (viewerContainer.scrollHeight || 1);
  currentScale = newScale;
  zoomLevel.textContent = Math.round(currentScale * 100) + '%';

  reRenderAllPages().then(() => {
    viewerContainer.scrollTop = scrollFraction * viewerContainer.scrollHeight;
  });
}

async function reRenderAllPages() {
  if (!pdfDoc) return;

  const firstPage = await pdfDoc.getPage(1);
  const viewport = firstPage.getViewport({ scale: currentScale });

  for (const pc of pageContainers) {
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

  setupIntersectionObserver();
}

// ── Page tracking ────────────────────────────────────────────────────
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

function getCurrentPageIndex() {
  const containerRect = viewerContainer.getBoundingClientRect();
  const midY = containerRect.top + containerRect.height / 2;
  for (const pc of pageContainers) {
    const rect = pc.container.getBoundingClientRect();
    if (rect.top <= midY && rect.bottom >= midY) return pc.pageIndex;
  }
  return 0;
}

viewerContainer.addEventListener('scroll', () => {
  updateCurrentPage();
  clearTimeout(positionSaveTimer);
  positionSaveTimer = setTimeout(saveReadingPosition, 2000);
});

// ── Reading position memory ──────────────────────────────────────────
function saveReadingPosition() {
  if (!currentPageKey || !isContextValid()) return;
  const scrollFraction = viewerContainer.scrollTop / (viewerContainer.scrollHeight || 1);
  chrome.storage.local.set({ [`pos:${currentPageKey}`]: { scrollFraction } });
}

async function restoreReadingPosition() {
  if (!currentPageKey || !isContextValid()) return;
  try {
    const key = `pos:${currentPageKey}`;
    const result = await chrome.storage.local.get([key]);
    const pos = result[key];
    if (pos?.scrollFraction) {
      requestAnimationFrame(() => {
        viewerContainer.scrollTop = pos.scrollFraction * viewerContainer.scrollHeight;
      });
    }
  } catch {}
}

// ── Storage helpers ──────────────────────────────────────────────────
function isContextValid() {
  try { return !!chrome.runtime?.id; } catch { return false; }
}

async function loadHighlights() {
  if (!currentPageKey || !isContextValid()) { highlights = []; return; }
  try {
    const result = await chrome.storage.local.get([currentPageKey]);
    const stored = result[currentPageKey];
    if (!Array.isArray(stored)) { highlights = []; return; }

    const before = stored.length;
    // Filter out malformed highlights (missing id, text, or pageIndex)
    highlights = stored.filter(h =>
      h && typeof h.id === 'string' && typeof h.text === 'string' &&
      typeof h.pageIndex === 'number'
    );

    // Auto-clear highlights created before CSS fix (missing position:absolute on
    // textLayer spans). Those highlights have wrong offsets. The 'color' field was
    // added in the same update, so its absence signals pre-fix data.
    if (highlights.length && highlights.some(h => !h.color)) {
      console.warn(`[Marginalia] Clearing ${highlights.length} pre-fix highlights (bad offsets)`);
      highlights = [];
    }

    if (highlights.length < before) {
      await chrome.storage.local.set({ [currentPageKey]: highlights });
    }

    if (highlights.length) {
      console.log(`[Marginalia] Loaded ${highlights.length} highlights for ${currentPageKey}`);
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

// ── Highlight application on rendered pages ──────────────────────────
function applyHighlightsToPage(pageIndex) {
  const pc = pageContainers[pageIndex];
  if (!pc || !pc.rendered) return;

  const pageHighlights = highlights.filter(h => h.pageIndex === pageIndex);
  if (!pageHighlights.length) return;

  const spans = Array.from(pc.textLayer.querySelectorAll('span:not(.oc-highlight)'));
  if (!spans.length) return;

  // Compute total text length on this page to validate highlight offsets
  const totalTextLen = spans.reduce((sum, s) => sum + s.textContent.length, 0);

  for (const h of pageHighlights) {
    // Skip highlights with suspiciously broad offsets (>80% of page text)
    // These are almost certainly bad data from mis-positioned text layer
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

function applyHighlightToTextLayer(allSpans, h) {
  // Primary: offset-based matching
  if (h.startOffset !== undefined && h.endOffset !== undefined) {
    const result = findSpansByOffset(allSpans, h.startOffset, h.endOffset);
    if (result.length > 0) {
      wrapSpansAsHighlight(result, h);
      return;
    }
  }

  // Fallback: text search (supports old highlight format without offsets)
  const allText = allSpans.map(s => s.textContent).join('');
  const searchText = h.text;
  const idx = allText.indexOf(searchText);
  if (idx === -1) return;

  const result = findSpansByOffset(allSpans, idx, idx + searchText.length);
  if (result.length > 0) {
    wrapSpansAsHighlight(result, h);
  }
}

function findSpansByOffset(spans, startOffset, endOffset) {
  const results = [];
  let pos = 0;
  for (const span of spans) {
    const len = span.textContent.length;
    const spanEnd = pos + len;
    if (spanEnd <= startOffset) { pos = spanEnd; continue; }
    if (pos >= endOffset) break;

    const s = Math.max(0, startOffset - pos);
    const e = Math.min(len, endOffset - pos);
    results.push({ span, start: s, end: e });
    pos = spanEnd;
  }
  return results;
}

function wrapSpansAsHighlight(spanRanges, h) {
  for (const { span, start, end } of spanRanges) {
    const text = span.textContent;
    if (start === 0 && end === text.length) {
      // Whole span — replace with absolutely-positioned mark
      const mark = createMark(h);
      mark.textContent = text;
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
  const color = h.color || 'orange';
  mark.className = `oc-highlight oc-hl-${color}${h.comment ? ' oc-highlight-comment' : ''}`;
  mark.dataset.ocId = h.id;
  mark.style.color = 'transparent';
  mark.style.position = 'absolute';
  mark.style.whiteSpace = 'pre';
  mark.addEventListener('click', e => {
    e.stopPropagation();
    if (!highlightMode) showNoteBubble(e, h);
  });
  return mark;
}

// Inline mark for partial-span highlights (nested inside the span, no positioning)
function createInlineMark(h) {
  const mark = document.createElement('mark');
  const color = h.color || 'orange';
  mark.className = `oc-highlight oc-hl-${color}${h.comment ? ' oc-highlight-comment' : ''}`;
  mark.dataset.ocId = h.id;
  mark.addEventListener('click', e => {
    e.stopPropagation();
    if (!highlightMode) showNoteBubble(e, h);
  });
  return mark;
}

// ── Selection and highlighting ───────────────────────────────────────
viewerContainer.addEventListener('mouseup', e => {
  if ([hlToolbar, annPopup, noteBubble, sidebar, modeBanner, searchBar].some(el => el?.contains(e.target))) return;

  hideNoteBubble();

  setTimeout(() => {
    const sel = window.getSelection();
    const text = sel?.toString().trim();
    if (!text || text.length < 2) {
      hideHlToolbar();
      return;
    }

    const pageContainer = sel.anchorNode?.parentElement?.closest('.page-container');
    if (!pageContainer) { hideHlToolbar(); return; }

    const pageIndex = parseInt(pageContainer.dataset.pageIndex);
    const pc = pageContainers[pageIndex];
    if (!pc) { hideHlToolbar(); return; }

    // :scope > matches only direct children of textLayer, avoiding double-counting
    // text inside inline marks (which are nested inside spans, not siblings)
    const spans = Array.from(pc.textLayer.querySelectorAll(':scope > span:not(.oc-highlight), :scope > mark'));
    const { startOffset, endOffset } = computeSelectionOffsets(sel, spans);

    pendingHighlight = { text, pageIndex, startOffset, endOffset };

    if (highlightMode) {
      const h = createHighlight(pendingHighlight, '');
      sel.removeAllRanges();
      if (h) showAnnotationPopup(h);
    } else {
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      hlToolbar.style.left = Math.max(8, rect.left + rect.width / 2 - 80) + 'px';
      hlToolbar.style.top = Math.max(8, rect.top - 40) + 'px';
      hlToolbar.classList.remove('hidden');
    }
  }, 10);
});

document.addEventListener('mousedown', e => {
  if (!hlToolbar.contains(e.target) && !hlToolbar.classList.contains('hidden')) hideHlToolbar();
  if (!noteBubble.contains(e.target) && !noteBubble.classList.contains('hidden')) hideNoteBubble();
  if (!annPopup.contains(e.target) && !annPopup.classList.contains('hidden')) hideAnnPopup();
});

function computeSelectionOffsets(sel, spans) {
  let totalOffset = 0;
  const nodeOffsets = new Map();
  for (const el of spans) {
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

  if (startOffset > endOffset) [startOffset, endOffset] = [endOffset, startOffset];

  return { startOffset, endOffset };
}

// ── Highlight toolbar actions ────────────────────────────────────────
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
  const h = createHighlight(pendingHighlight, '');
  hideHlToolbar();
  window.getSelection()?.removeAllRanges();
  if (h) showAnnotationPopup(h);
});

function createHighlight(pending, comment) {
  // Attempt LaTeX reconstruction from text layer spans
  const pc = pageContainers[pending.pageIndex];
  const spans = pc ? Array.from(pc.textLayer.querySelectorAll('span:not(.oc-highlight)')) : [];
  const latex = reconstructMathText(spans, pending.startOffset, pending.endOffset);

  const h = {
    id: crypto.randomUUID(),
    text: pending.text.slice(0, 300),
    comment,
    timestamp: new Date().toISOString(),
    pageIndex: pending.pageIndex,
    startOffset: pending.startOffset,
    endOffset: pending.endOffset,
    color: activeColor,
    ...(latex ? { latex } : {})
  };

  highlights.push(h);
  saveHighlightsToStorage();
  ensureReadingExists();
  notifyHighlightChanged('create', h.text, h.id);

  reRenderPage(pending.pageIndex);
  refreshSidebarHighlights();

  return h;
}

async function reRenderPage(pageIndex) {
  const pc = pageContainers[pageIndex];
  if (!pc) return;

  if (pc.renderTask) {
    try { pc.renderTask.cancel(); } catch {}
    pc.renderTask = null;
  }

  pc.rendered = false;
  pc.rendering = false;
  pc.textLayer.innerHTML = '';
  pc.canvas.width = 0;
  pc.canvas.height = 0;
  await renderPage(pageIndex);
}

// ── Annotation popup ─────────────────────────────────────────────────
function showAnnotationPopup(h) {
  const mark = document.querySelector(`mark[data-oc-id="${CSS.escape(h.id)}"]`);
  if (!mark) return;

  const rect = mark.getBoundingClientRect();
  annPopup.style.left = Math.max(8, rect.left) + 'px';
  annPopup.style.top = (rect.bottom + 4) + 'px';
  annPopup.classList.remove('hidden');
  annInput.value = '';
  annInput.focus();

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

// ── Note bubble ──────────────────────────────────────────────────────
function showNoteBubble(event, h) {
  hideNoteBubble();
  hideHlToolbar();

  const hasComment = !!h.comment;
  const color = HL_COLORS[h.color || 'orange'] || HL_COLORS.orange;

  noteBubble.innerHTML = `
    <div class="nb-quote" style="border-left-color:${color}">${escHtml(h.text.length > 120 ? h.text.slice(0, 120) + '\u2026' : h.text)}</div>
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

  noteBubble.querySelector('.nb-delete').addEventListener('click', () => {
    deleteHighlight(h.id);
    hideNoteBubble();
  });

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

// ── Highlight CRUD ───────────────────────────────────────────────────
function updateHighlightComment(id, comment) {
  const h = highlights.find(hl => hl.id === id);
  if (!h) return;
  h.comment = comment;
  saveHighlightsToStorage();
  notifyHighlightChanged('update', h.text, h.id);
  reRenderPage(h.pageIndex);
  refreshSidebarHighlights();
}

function deleteHighlight(id) {
  const h = highlights.find(hl => hl.id === id);
  if (!h) return;
  highlights = highlights.filter(hl => hl.id !== id);
  saveHighlightsToStorage();
  notifyHighlightChanged('delete', '', id);
  reRenderPage(h.pageIndex);
  refreshSidebarHighlights();
}

// ── Hide helpers ─────────────────────────────────────────────────────
function hideHlToolbar() { hlToolbar.classList.add('hidden'); }
function hideAnnPopup() { annPopup.classList.add('hidden'); annInput.onkeydown = null; }
function hideNoteBubble() { noteBubble.classList.add('hidden'); }

// ── Highlight mode ───────────────────────────────────────────────────
function enterHighlightMode() {
  highlightMode = true;
  document.getElementById('btn-highlight-mode').classList.add('active');
  modeBanner.classList.remove('hidden');
  hideHlToolbar();
  hideNoteBubble();
  hideAnnPopup();
}

function exitHighlightMode() {
  highlightMode = false;
  document.getElementById('btn-highlight-mode').classList.remove('active');
  modeBanner.classList.add('hidden');
  hideAnnPopup();
  window.getSelection()?.removeAllRanges();
}

// ── Sidebar ──────────────────────────────────────────────────────────
function toggleSidebar() {
  const btn = document.getElementById('btn-sidebar');
  if (sidebar.classList.contains('hidden')) {
    sidebar.classList.remove('hidden');
    btn.classList.add('active');
    loadSidebarNotes();
    refreshSidebarHighlights();
  } else {
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
      title: currentTitle || currentPageKey,
      url: currentPageKey,
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

  list.innerHTML = highlights.map(h => {
    const color = HL_COLORS[h.color || 'orange'] || HL_COLORS.orange;
    return `
    <div class="sb-hl-item" data-hl-id="${escAttr(h.id)}" data-page="${h.pageIndex ?? 0}">
      <div class="sb-hl-quote">
        <span class="sb-hl-color" style="background:${color}"></span>
        <span class="sb-hl-text">"${escHtml(h.text.length > 120 ? h.text.slice(0, 120) + '\u2026' : h.text)}"</span>
      </div>
      ${h.latex ? `<div class="sb-hl-latex"><code>${escHtml(h.latex)}</code></div>` : ''}
      ${h.comment ? `<div class="sb-hl-comment">\u2014 ${escHtml(h.comment)}</div>` : ''}
      <div class="sb-hl-page">Page ${(h.pageIndex ?? 0) + 1}</div>
    </div>
  `;
  }).join('');

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

// ── In-PDF text search ───────────────────────────────────────────────
function toggleSearch() {
  if (searchBar.classList.contains('hidden')) {
    searchBar.classList.remove('hidden');
    searchInput.focus();
  } else {
    closeSearch();
  }
}

function closeSearch() {
  searchBar.classList.add('hidden');
  searchInput.value = '';
  searchCount.textContent = '';
  clearSearchHighlights();
  searchMatches = [];
  searchIndex = -1;
}

async function ensurePageTexts() {
  if (pageTexts) return;
  if (!pdfDoc) return;
  pageTexts = [];
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const page = await pdfDoc.getPage(i);
    const tc = await page.getTextContent();
    pageTexts.push(tc.items.map(item => item.str).join(''));
  }
}

async function performSearch(query) {
  clearSearchHighlights();
  searchMatches = [];
  searchIndex = -1;

  if (!query || query.length < 2) {
    searchCount.textContent = '';
    return;
  }

  await ensurePageTexts();
  const q = query.toLowerCase();

  for (let i = 0; i < pageTexts.length; i++) {
    const text = pageTexts[i].toLowerCase();
    let pos = 0;
    while ((pos = text.indexOf(q, pos)) !== -1) {
      searchMatches.push({ pageIndex: i, startOffset: pos, endOffset: pos + query.length });
      pos += query.length;
    }
  }

  if (searchMatches.length > 0) {
    searchCount.textContent = `${searchMatches.length} match${searchMatches.length !== 1 ? 'es' : ''}`;
    searchIndex = 0;
    highlightSearchMatch(searchIndex);
  } else {
    searchCount.textContent = 'No matches';
  }
}

function navigateSearch(direction) {
  if (!searchMatches.length) return;
  clearSearchHighlights();
  searchIndex = (searchIndex + direction + searchMatches.length) % searchMatches.length;
  highlightSearchMatch(searchIndex);
}

function highlightSearchMatch(idx) {
  const match = searchMatches[idx];
  if (!match) return;

  searchCount.textContent = `${idx + 1} of ${searchMatches.length}`;

  const pc = pageContainers[match.pageIndex];
  if (!pc) return;

  const applyMatch = () => {
    const spans = Array.from(pc.textLayer.querySelectorAll('span:not(.search-match)'));
    if (!spans.length) return;

    const results = findSpansByOffset(spans, match.startOffset, match.endOffset);
    for (const { span, start, end } of results) {
      const text = span.textContent;
      if (start === 0 && end === text.length) {
        span.classList.add('search-match', 'active');
      } else {
        // Wrap inline within the span to avoid absolute-position overlap
        const textNode = span.firstChild;
        if (!textNode || textNode.nodeType !== Node.TEXT_NODE) continue;
        const range = document.createRange();
        range.setStart(textNode, start);
        range.setEnd(textNode, end);
        const wrapper = document.createElement('span');
        wrapper.className = 'search-match active';
        range.surroundContents(wrapper);
      }
    }
  };

  pc.container.scrollIntoView({ behavior: 'smooth', block: 'center' });

  if (pc.rendered) {
    applyMatch();
  } else {
    const checkRender = setInterval(() => {
      if (pc.rendered) {
        clearInterval(checkRender);
        applyMatch();
      }
    }, 100);
    setTimeout(() => clearInterval(checkRender), 5000);
  }
}

function clearSearchHighlights() {
  document.querySelectorAll('.search-match').forEach(el => {
    if (el.tagName === 'SPAN' && el.parentNode) {
      // Unwrap inline search wrappers: move children up and remove wrapper
      const parent = el.parentNode;
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
      parent.normalize(); // merge adjacent text nodes
    } else {
      el.classList.remove('search-match', 'active');
    }
  });
}

// ── Export highlights as Markdown ─────────────────────────────────────
async function exportHighlightsAsMarkdown() {
  let md = `# ${currentTitle}\n\n`;

  if (highlights.length) {
    md += `## Highlights\n\n`;
    const sorted = [...highlights].sort((a, b) =>
      (a.pageIndex ?? 0) - (b.pageIndex ?? 0) || (a.startOffset ?? 0) - (b.startOffset ?? 0)
    );
    for (const h of sorted) {
      md += `> ${h.text}\n`;
      if (h.latex) md += `>\n> **LaTeX:** \`${h.latex}\`\n`;
      if (h.comment) md += `> — *${h.comment}*\n`;
      const meta = [`Page ${(h.pageIndex ?? 0) + 1}`];
      if (h.color && h.color !== 'orange') meta.push(h.color);
      md += `> *(${meta.join(', ')})*\n\n`;
    }
  }

  const notes = document.getElementById('sb-notes')?.value?.trim();
  if (notes) {
    md += `## Notes\n\n${notes}\n\n`;
  }

  md += `---\n*Exported from Marginalia on ${new Date().toLocaleDateString()}*\n`;

  try {
    await navigator.clipboard.writeText(md);
    showToast('Highlights copied to clipboard');
  } catch {
    showToast('Failed to copy — check clipboard permissions');
  }
}

async function shareCurrentPage() {
  const btn = document.getElementById('btn-share');
  const origText = btn.textContent;
  btn.textContent = 'Sharing...';
  btn.disabled = true;

  try {
    // Get reading metadata from storage
    const readingRes = await chrome.runtime.sendMessage({ type: 'oc-get-reading', pageKey: currentPageKey });
    const reading = readingRes?.reading || {};

    const result = await shareAnnotations({
      pageKey: currentPageKey,
      title: reading.title || currentTitle,
      author: reading.author || '',
      url: reading.url || currentPageKey,
      notes: document.getElementById('sb-notes')?.value?.trim() || reading.notes || '',
      tags: reading.tags || [],
      highlights
    });

    const shareUrl = getShareUrl(result.shareCode, reading.url || currentPageKey);
    await navigator.clipboard.writeText(shareUrl);
    showToast(result.updated ? 'Share updated — link copied!' : 'Share link copied to clipboard!');
  } catch (e) {
    showToast(e.message || 'Failed to share');
  }

  btn.textContent = origText;
  btn.disabled = false;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 2500);
}

// ── Background communication ─────────────────────────────────────────
function ensureReadingExists(numPages) {
  if (!currentPageKey || !isContextValid()) return;
  try {
    chrome.runtime.sendMessage({
      type: 'oc-upsert-reading',
      pageKey: currentPageKey,
      title: currentTitle || currentPageKey,
      url: currentPageKey,
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

// ── Meta editing (title & author) ────────────────────────────────────
document.getElementById('btn-edit-meta').addEventListener('click', toggleMetaEdit);
document.getElementById('meta-save').addEventListener('click', saveMetaEdit);
document.getElementById('meta-cancel').addEventListener('click', closeMetaEdit);

function toggleMetaEdit() {
  if (metaEditPanel.classList.contains('hidden')) {
    metaTitleInput.value = currentTitle;
    metaAuthorInput.value = currentAuthor;
    metaEditPanel.classList.remove('hidden');
    metaTitleInput.focus();
    metaTitleInput.select();
  } else {
    closeMetaEdit();
  }
}

function closeMetaEdit() {
  metaEditPanel.classList.add('hidden');
}

async function saveMetaEdit() {
  const newTitle = metaTitleInput.value.trim();
  const newAuthor = metaAuthorInput.value.trim();
  if (!currentPageKey) return;

  const titleChanged = newTitle && newTitle !== currentTitle;
  const authorChanged = newAuthor !== currentAuthor;
  if (!titleChanged && !authorChanged) { closeMetaEdit(); return; }

  // Update local state + IndexedDB
  if (titleChanged) {
    currentTitle = newTitle;
    toolbarTitle.textContent = currentTitle;
    document.title = `Marginalia — ${currentTitle}`;
    await updateTranscriptField(currentPageKey, 'title', newTitle);
  }
  if (authorChanged) {
    currentAuthor = newAuthor;
    toolbarAuthor.textContent = newAuthor ? `by ${newAuthor}` : '';
    await updateTranscriptField(currentPageKey, 'author', newAuthor);
  }

  // Single message to sync both fields
  const msg = { type: 'oc-upsert-reading', pageKey: currentPageKey };
  if (titleChanged) msg.title = newTitle;
  if (authorChanged) msg.author = newAuthor;
  await chrome.runtime.sendMessage(msg);

  closeMetaEdit();
}

metaTitleInput.addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Enter') saveMetaEdit();
  if (e.key === 'Escape') closeMetaEdit();
});
metaAuthorInput.addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Enter') saveMetaEdit();
  if (e.key === 'Escape') closeMetaEdit();
});

// ── Keyboard shortcuts ───────────────────────────────────────────────
document.addEventListener('keydown', e => {
  const tag = document.activeElement?.tagName;
  const isInput = tag === 'INPUT' || tag === 'TEXTAREA';

  if (e.key === 'Escape') {
    if (!metaEditPanel.classList.contains('hidden')) { closeMetaEdit(); return; }
    if (!searchBar.classList.contains('hidden')) { closeSearch(); return; }
    if (highlightMode) { exitHighlightMode(); return; }
    hideHlToolbar();
    hideAnnPopup();
    hideNoteBubble();
    return;
  }

  // Cmd+F → search
  if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
    e.preventDefault();
    toggleSearch();
    return;
  }

  // Zoom
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

  // Cmd+S → save notes
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    clearTimeout(sidebarSaveTimer);
    saveSidebarNote();
  }

  // H → toggle highlight mode (when not typing)
  if (!isInput && e.key === 'h' && !e.metaKey && !e.ctrlKey) {
    if (highlightMode) exitHighlightMode(); else enterHighlightMode();
  }

  // E → toggle meta edit panel (when not typing)
  if (!isInput && e.key === 'e' && !e.metaKey && !e.ctrlKey) {
    toggleMetaEdit();
  }
});

// ── Markdown + LaTeX rendering pipeline ──────────────────────────────
function renderMarkdownWithMath(text) {
  if (!text) return '';
  // marked and DOMPurify are loaded via <script> tags
  if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') return escHtml(text);

  let html = marked.parse(text);
  html = DOMPurify.sanitize(html);

  // Render KaTeX: $$...$$ (display) and $...$ (inline)
  if (typeof katex !== 'undefined') {
    // Display math: $$...$$
    html = html.replace(/\$\$([\s\S]+?)\$\$/g, (_match, tex) => {
      try {
        return katex.renderToString(tex.trim(), { displayMode: true, throwOnError: false });
      } catch { return `<code>${escHtml(tex)}</code>`; }
    });
    // Inline math: $...$  (not preceded by \ or $)
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

  // Collect spans in the highlight range
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

  // Check if any math-like Unicode characters are present
  const fullText = rangeSpans.map(s => s.textContent).join('');
  const hasMathChars = /[\u03B1-\u03C9\u0393-\u03A9\u2200-\u22FF\u221A\u222B\u2211\u220F\u2202\u2207]/.test(fullText);
  if (!hasMathChars) return null;

  // Analyze font sizes and positions to detect sub/superscripts
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
      // Smaller text — likely sub or superscript
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

// ── Utility ──────────────────────────────────────────────────────────
function escHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;');
}

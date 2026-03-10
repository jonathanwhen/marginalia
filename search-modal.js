// search-modal.js — Global search modal (Cmd+K)
// Uses MiniSearch for client-side full-text indexing across readings,
// highlights, and PDF transcript content. Self-contained IIFE that
// injects its own DOM and listens for Cmd+K / Ctrl+K globally.

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────
  let miniSearch = null;
  let overlay = null;
  let isOpen = false;
  let selectedIndex = 0;
  let results = [];
  let indexBuilt = false;

  // ── SVG icons (inline to avoid asset dependencies) ─────────────────
  const ICONS = {
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
    reading: '\u{1F4D6}',   // open book
    highlight: '\u{1F4CC}', // pushpin
    pdf: '\u{1F4C4}',       // page facing up
  };

  // ── Build search index from chrome.storage + IndexedDB ─────────────
  async function buildIndex() {
    const documents = [];
    let docId = 0;

    // 1. Readings from chrome.storage.local
    let readings = {};
    try {
      const data = await chrome.storage.local.get('ocReadings');
      readings = data.ocReadings || {};
    } catch (_) {
      // Not in extension context (e.g. local dev) — skip
    }

    for (const [pageKey, r] of Object.entries(readings)) {
      documents.push({
        id: docId++,
        type: 'reading',
        pageKey,
        title: r.title || '',
        author: r.author || '',
        text: [r.title, r.author, r.notes, (r.tags || []).join(' ')].filter(Boolean).join(' '),
        snippet: r.notes ? r.notes.slice(0, 150) : (r.tags || []).join(', '),
        url: r.url || pageKey,
      });
    }

    // 2. Highlights — stored as arrays under page-key keys
    const skipKeys = new Set([
      'ocReadings', 'ocGitHubSha', 'ocMarkdownShas',
      'ocSupabaseSession', 'ocLastSyncResult',
    ]);
    try {
      const allStorage = await chrome.storage.local.get(null);
      for (const [key, val] of Object.entries(allStorage)) {
        if (skipKeys.has(key) || key.startsWith('pos:') || !Array.isArray(val)) continue;
        const reading = readings[key];
        for (const h of val) {
          if (!h.text && !h.comment) continue;
          documents.push({
            id: docId++,
            type: 'highlight',
            pageKey: key,
            title: reading?.title || key,
            text: [h.text, h.comment, h.latex].filter(Boolean).join(' '),
            snippet: h.text ? h.text.slice(0, 150) : (h.comment?.slice(0, 150) || ''),
            url: reading?.url || key,
            highlightId: h.id,
          });
        }
      }
    } catch (_) { /* not in extension context */ }

    // 3. PDF transcripts from IndexedDB (or Electron IPC)
    try {
      const transcripts = await getTranscripts();
      for (const t of transcripts) {
        if (!t.content) continue;
        documents.push({
          id: docId++,
          type: 'pdf',
          pageKey: t.pageKey,
          title: t.title || t.fileName || t.pageKey,
          text: [t.title, t.author, t.content.slice(0, 50000)].filter(Boolean).join(' '),
          snippet: t.content.slice(0, 150),
          url: t.pageKey,
        });
      }
    } catch (e) {
      console.warn('search: could not index PDF transcripts', e);
    }

    // Create MiniSearch instance
    miniSearch = new MiniSearch({
      fields: ['text', 'title', 'author'],
      storeFields: ['type', 'pageKey', 'title', 'snippet', 'url', 'highlightId'],
      searchOptions: {
        prefix: true,
        fuzzy: 0.2,
        boost: { title: 3, author: 2 },
      },
    });
    miniSearch.addAll(documents);
    indexBuilt = true;
  }

  // Retrieve PDF transcripts — delegates to Electron IPC or IndexedDB
  async function getTranscripts() {
    if (typeof window !== 'undefined' && window.__marginaliaLibrary) {
      return window.__marginaliaLibrary.getAllTranscriptsMeta();
    }
    return getTranscriptsFromIDB();
  }

  function getTranscriptsFromIDB() {
    return new Promise((resolve) => {
      let req;
      try {
        req = indexedDB.open('marginaliaDB', 1);
      } catch (_) {
        resolve([]);
        return;
      }
      req.onerror = () => resolve([]);
      req.onupgradeneeded = () => resolve([]);
      req.onsuccess = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('transcripts')) { resolve([]); return; }
        const tx = db.transaction('transcripts', 'readonly');
        const store = tx.objectStore('transcripts');
        const all = store.getAll();
        all.onsuccess = () => resolve(all.result || []);
        all.onerror = () => resolve([]);
      };
    });
  }

  // ── DOM creation ───────────────────────────────────────────────────
  function createOverlay() {
    if (overlay) return;

    overlay = document.createElement('div');
    overlay.className = 'search-overlay';
    overlay.innerHTML = `
      <div class="search-modal">
        <div class="search-modal-input-wrap">
          <span class="search-modal-icon">${ICONS.search}</span>
          <input class="search-modal-input" type="text" placeholder="Search readings, highlights, PDFs..." autocomplete="off" spellcheck="false" />
          <span class="search-modal-kbd">ESC</span>
        </div>
        <div class="search-modal-results">
          <div class="search-modal-empty">Type to search across all your content</div>
        </div>
        <div class="search-modal-footer">
          <span><kbd>&uarr;</kbd> <kbd>&darr;</kbd> navigate</span>
          <span><kbd>Enter</kbd> open</span>
          <span><kbd>ESC</kbd> close</span>
        </div>
      </div>
    `;

    // Close on backdrop click
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
    });

    // Input handler with debounce
    const input = overlay.querySelector('.search-modal-input');
    let debounceTimer = null;
    input.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => doSearch(input.value.trim()), 80);
    });

    // Keyboard navigation within modal
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeModal();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        selectedIndex = Math.min(selectedIndex + 1, results.length - 1);
        updateSelection();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        selectedIndex = Math.max(selectedIndex - 1, 0);
        updateSelection();
        return;
      }
      if (e.key === 'Enter' && results.length > 0) {
        e.preventDefault();
        navigateToResult(results[selectedIndex]);
      }
    });

    document.body.appendChild(overlay);
  }

  // ── Search + render ────────────────────────────────────────────────
  function doSearch(query) {
    const container = overlay.querySelector('.search-modal-results');
    if (!query) {
      container.innerHTML = '<div class="search-modal-empty">Type to search across all your content</div>';
      results = [];
      selectedIndex = 0;
      return;
    }

    if (!miniSearch) {
      container.innerHTML = '<div class="search-modal-empty">Building index...</div>';
      return;
    }

    const raw = miniSearch.search(query, { prefix: true, fuzzy: 0.2 });
    results = raw.slice(0, 50); // Cap displayed results
    selectedIndex = 0;

    if (results.length === 0) {
      container.innerHTML = '<div class="search-modal-empty">No results for \u201C' + escapeHtml(query) + '\u201D</div>';
      return;
    }

    // Group by type, preserving relevance order within each group
    const groups = { reading: [], highlight: [], pdf: [] };
    for (const r of results) {
      (groups[r.type] || groups.reading).push(r);
    }

    const groupLabels = {
      reading: 'Readings',
      highlight: 'Highlights',
      pdf: 'PDF Content',
    };

    let html = '';
    let flatIndex = 0;
    for (const type of ['reading', 'highlight', 'pdf']) {
      const items = groups[type];
      if (items.length === 0) continue;
      html += '<div class="search-modal-group-label">' + groupLabels[type] + '</div>';
      for (const item of items) {
        const snippet = highlightSnippet(item.snippet || '', query);
        html += '<div class="search-modal-result' + (flatIndex === 0 ? ' selected' : '') + '" data-index="' + flatIndex + '">'
          + '<span class="search-modal-result-icon">' + ICONS[type] + '</span>'
          + '<div class="search-modal-result-body">'
          + '<div class="search-modal-result-title">' + escapeHtml(item.title) + '</div>'
          + (snippet ? '<div class="search-modal-result-snippet">' + snippet + '</div>' : '')
          + '</div></div>';
        flatIndex++;
      }
    }
    container.innerHTML = html;

    // Click + hover handlers on results
    container.querySelectorAll('.search-modal-result').forEach(function (el) {
      el.addEventListener('click', function () {
        var idx = parseInt(el.dataset.index, 10);
        navigateToResult(results[idx]);
      });
      el.addEventListener('mouseenter', function () {
        selectedIndex = parseInt(el.dataset.index, 10);
        updateSelection();
      });
    });
  }

  function updateSelection() {
    if (!overlay) return;
    var items = overlay.querySelectorAll('.search-modal-result');
    items.forEach(function (el, i) {
      el.classList.toggle('selected', i === selectedIndex);
    });
    // Scroll selected into view
    var sel = items[selectedIndex];
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }

  function highlightSnippet(text, query) {
    if (!text || !query) return escapeHtml(text);
    var escaped = escapeHtml(text);
    var words = query.split(/\s+/).filter(Boolean).map(escapeRegExp);
    if (words.length === 0) return escaped;
    var pattern = new RegExp('(' + words.join('|') + ')', 'gi');
    return escaped.replace(pattern, '<mark>$1</mark>');
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // ── Navigation ─────────────────────────────────────────────────────
  function navigateToResult(result) {
    if (!result) return;
    closeModal();

    if (result.type === 'pdf' || (result.pageKey && result.pageKey.startsWith('library:'))) {
      window.location.href = 'library-reader.html?key=' + encodeURIComponent(result.pageKey);
    } else if (result.url && result.url !== result.pageKey) {
      window.open(result.url, '_blank');
    } else {
      window.location.href = 'dashboard.html';
    }
  }

  // ── Open / close ───────────────────────────────────────────────────
  async function openModal() {
    createOverlay();
    isOpen = true;
    overlay.classList.add('open');

    var input = overlay.querySelector('.search-modal-input');
    input.value = '';
    input.focus();

    // Reset results display
    var container = overlay.querySelector('.search-modal-results');
    container.innerHTML = '<div class="search-modal-empty">Type to search across all your content</div>';
    results = [];
    selectedIndex = 0;

    // Build index on first open (or rebuild if storage changed)
    if (!indexBuilt) {
      container.innerHTML = '<div class="search-modal-empty">Building search index...</div>';
      try {
        await buildIndex();
      } catch (e) {
        console.error('search: failed to build index', e);
      }
      container.innerHTML = '<div class="search-modal-empty">Type to search across all your content</div>';
    }
  }

  function closeModal() {
    if (!overlay) return;
    isOpen = false;
    overlay.classList.remove('open');
  }

  function toggleModal() {
    if (isOpen) { closeModal(); } else { openModal(); }
  }

  // ── Global keyboard shortcut: Cmd+K / Ctrl+K ──────────────────────
  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      toggleModal();
    }
  });

  // ── Expose toggle for the nav button ───────────────────────────────
  window.__searchModalToggle = toggleModal;

  // ── Invalidate index when storage changes so next open rebuilds ────
  try {
    chrome.storage.onChanged.addListener(function () { indexBuilt = false; miniSearch = null; });
  } catch (_) { /* not in extension context */ }
})();

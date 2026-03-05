import { getSharedPage } from './lib/supabase.js';

const loadingEl = document.getElementById('loading');
const contentEl = document.getElementById('content');
const errorEl = document.getElementById('error');

const params = new URLSearchParams(location.search);
const shareCode = params.get('code');

if (!shareCode) {
  showError('No share code', 'This link is missing a share code. Check the URL and try again.');
} else {
  loadSharedPage(shareCode);
}

async function loadSharedPage(code) {
  try {
    const page = await getSharedPage(code);
    renderPage(page);
  } catch (e) {
    showError('Not found', 'This shared link may have been deleted or the code is invalid.');
  }
}

function renderPage(page) {
  loadingEl.style.display = 'none';
  contentEl.style.display = 'block';

  const sharedBy = page.profiles?.display_name || 'Someone';
  const date = new Date(page.created_at).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric'
  });

  const highlights = (page.highlights || []).sort((a, b) =>
    (a.pageIndex ?? 0) - (b.pageIndex ?? 0) || (a.startOffset ?? 0) - (b.startOffset ?? 0)
  );

  let html = '';

  // Badge
  html += `<div class="shared-badge"><span class="dot"></span>Shared by ${esc(sharedBy)} on ${date}</div>`;

  // Title
  html += `<h1>${esc(page.title)}</h1>`;

  // Meta
  const metaParts = [];
  if (page.author) metaParts.push(`<span class="author">${esc(page.author)}</span>`);
  if (page.url && !page.url.startsWith('library:')) {
    metaParts.push(`<a href="${esc(page.url)}" target="_blank" rel="noopener">View source</a>`);
  }
  if (metaParts.length) html += `<div class="meta">${metaParts.join(' · ')}</div>`;

  // Tags
  if (page.tags?.length) {
    html += `<div class="tags">${page.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>`;
  }

  // Notes
  if (page.notes?.trim()) {
    html += `<div class="notes-section"><h2>Notes</h2><div class="notes-body">${esc(page.notes)}</div></div>`;
  }

  // Highlights
  if (highlights.length) {
    html += `<div class="highlights-section"><h2>Highlights (${highlights.length})</h2>`;
    for (const h of highlights) {
      const colorClass = h.color && h.color !== 'orange' ? ` ${h.color}` : '';
      html += `<div class="highlight-card${colorClass}">`;
      html += `<div class="hl-text">"${esc(h.text)}"</div>`;
      if (h.latex) html += `<div class="hl-latex"><code>${esc(h.latex)}</code></div>`;
      if (h.comment) html += `<div class="hl-comment">${esc(h.comment)}</div>`;
      const meta = [];
      if (h.pageIndex != null) meta.push(`Page ${h.pageIndex + 1}`);
      if (h.timestamp) meta.push(new Date(h.timestamp).toLocaleDateString());
      if (meta.length) html += `<div class="hl-meta">${meta.join(' · ')}</div>`;
      html += `</div>`;
    }
    html += `</div>`;
  }

  if (!highlights.length && !page.notes?.trim()) {
    html += `<div class="empty-state"><p>No annotations to show.</p></div>`;
  }

  contentEl.innerHTML = html;
  document.title = `${page.title} — Marginalia`;
}

function showError(title, message) {
  loadingEl.style.display = 'none';
  errorEl.style.display = 'block';
  errorEl.innerHTML = `<div class="error-state"><h2>${esc(title)}</h2><p>${esc(message)}</p></div>`;
}

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

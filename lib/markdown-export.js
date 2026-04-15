/**
 * Shared Obsidian-compatible markdown builder for readings.
 *
 * Pure ES module — no chrome.* or DOM dependencies.
 * Extracts and extends the formatting logic from export.js so that
 * both the bulk Obsidian export and per-reading sync can share
 * identical markdown output.
 */

// ── Slug generation ──────────────────────────────────────────────
// Deterministic, URL-safe slug from a title string.
// Lowercase, collapse non-alphanum runs to hyphens, trim edges, max 80 chars.
export function slugify(title) {
  return (title || 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

// ── YAML helpers ─────────────────────────────────────────────────
// Always wraps the value in double quotes, escaping backslashes and
// double-quote characters inside.
export function yamlEscape(str) {
  const s = String(str ?? '');
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// ── Frontmatter ──────────────────────────────────────────────────
// Builds YAML frontmatter with all reading metadata.
// Adds conversation, starred, and aliases fields beyond the original export.js.
function buildFrontmatter(reading) {
  const lines = ['---'];
  lines.push('title: ' + yamlEscape(reading.title || 'Untitled'));
  if (reading.author) lines.push('author: ' + yamlEscape(reading.author));
  if (reading.tags && reading.tags.length) {
    lines.push('tags: [' + reading.tags.map(function (t) { return yamlEscape(t); }).join(', ') + ']');
  }
  if (reading.url) lines.push('url: ' + yamlEscape(reading.url));
  if (reading.conversationUrl) lines.push('conversation: ' + yamlEscape(reading.conversationUrl));
  if (reading.starred) lines.push('starred: true');
  if (reading.mediaType) lines.push('mediaType: ' + yamlEscape(reading.mediaType));
  if (reading.duration) lines.push('duration: ' + reading.duration);
  if (reading.estPages) lines.push('pages: ' + reading.estPages);
  lines.push('created: ' + yamlEscape(reading.createdAt || ''));
  lines.push('updated: ' + yamlEscape(reading.updatedAt || ''));
  lines.push('aliases: [' + yamlEscape(slugify(reading.title)) + ']');
  lines.push('---');
  return lines.join('\n');
}

// ── Reading log table ────────────────────────────────────────────
// Markdown table with Date/Pages columns and a totals row.
function buildReadingLogSection(readingLog) {
  if (!readingLog || !Object.keys(readingLog).length) return '';
  var sortedDates = Object.keys(readingLog).sort();
  var totalPages = sortedDates.reduce(function (sum, d) { return sum + readingLog[d]; }, 0);
  var lines = [
    '## Reading Log',
    '',
    '| Date | Pages |',
    '|------|------:|'
  ];
  for (var i = 0; i < sortedDates.length; i++) {
    lines.push('| ' + sortedDates[i] + ' | ' + readingLog[sortedDates[i]] + ' |');
  }
  lines.push('| **Total** | **' + totalPages + '** |');
  lines.push('');
  return lines.join('\n');
}

// ── Highlights section ───────────────────────────────────────────
// Sorted by pageIndex then startOffset. Includes page markers, blockquote
// text, inline LaTeX, color metadata, and comments.
function formatHighlightList(sorted) {
  var lines = [];
  for (var i = 0; i < sorted.length; i++) {
    var h = sorted[i];
    // Page marker for PDFs
    if (h.pageIndex !== undefined) {
      lines.push('*Page ' + (h.pageIndex + 1) + '*');
      lines.push('');
    }
    // Quote text — render inline LaTeX as $...$ on a separate blockquote line
    var text = h.text || '';
    if (h.latex) {
      lines.push('> ' + text);
      lines.push('> $' + h.latex + '$');
    } else {
      lines.push('> ' + text);
    }
    // Color metadata if non-default
    if (h.color && h.color !== 'orange') {
      lines.push('> *(' + h.color + ')*');
    }
    // Comment as sub-bullet
    if (h.comment) {
      lines.push('');
      lines.push('- ' + h.comment);
    }
    lines.push('');
  }
  return lines;
}

function buildHighlightsSection(highlights) {
  if (!highlights || !highlights.length) return '';
  var articleHl = highlights.filter(function (h) { return h.source !== 'conversation'; });
  var convHl = highlights.filter(function (h) { return h.source === 'conversation'; });

  var sortFn = function (a, b) {
    return (a.pageIndex || 0) - (b.pageIndex || 0) || (a.startOffset || 0) - (b.startOffset || 0);
  };

  var lines = [];

  if (articleHl.length) {
    lines.push('## Highlights');
    lines.push('');
    lines = lines.concat(formatHighlightList(articleHl.slice().sort(sortFn)));
  }

  if (convHl.length) {
    lines.push('## Conversation Annotations');
    lines.push('');
    lines = lines.concat(formatHighlightList(convHl.slice().sort(sortFn)));
  }

  // Fallback: if no article or conv (shouldn't happen, but defensive)
  if (!articleHl.length && !convHl.length) return '';

  return lines.join('\n');
}

// ── Backlinks section ────────────────────────────────────────────
// Finds other readings sharing at least one tag with this reading.
// slugMap is { slug: { title, tags } }. Pass null to skip entirely.
function buildBacklinks(reading, slugMap) {
  if (!slugMap) return '';
  if (!reading.tags || !reading.tags.length) return '';
  var links = [];
  var seen = {};
  for (var slug in slugMap) {
    if (slug === slugify(reading.title)) continue;
    var other = slugMap[slug];
    if (!other.tags) continue;
    for (var i = 0; i < reading.tags.length; i++) {
      if (other.tags.indexOf(reading.tags[i]) !== -1 && !seen[slug]) {
        links.push('- [[' + slug + '|' + (other.title || 'Untitled') + ']]');
        seen[slug] = true;
        break;
      }
    }
  }
  if (!links.length) return '';
  return '## Related\n\n' + links.join('\n') + '\n';
}

// ── Full reading markdown ────────────────────────────────────────
// Assembles the complete markdown string for a single reading.
// Pass slugMap = null to omit the backlinks/related section.
export function buildMarkdownForReading(reading, highlights, slugMap) {
  var parts = [];
  parts.push(buildFrontmatter(reading));
  parts.push('');
  parts.push('# ' + (reading.title || 'Untitled'));
  parts.push('');

  // Notes
  if (reading.notes) {
    parts.push('## Notes');
    parts.push('');
    parts.push(reading.notes);
    parts.push('');
  }

  // Reading log as table
  var logSection = buildReadingLogSection(reading.readingLog);
  if (logSection) parts.push(logSection);

  // Highlights
  var hlSection = buildHighlightsSection(highlights);
  if (hlSection) parts.push(hlSection);

  // Backlinks (skipped when slugMap is null)
  var blSection = buildBacklinks(reading, slugMap);
  if (blSection) parts.push(blSection);

  return parts.join('\n');
}

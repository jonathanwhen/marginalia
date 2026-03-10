/**
 * Marginalia Obsidian/Markdown Export
 *
 * Builds interlinked markdown files from all readings, highlights, and tags,
 * then packages them as a .zip for Obsidian-compatible vaults.
 *
 * Exposed as window.__marginaliaExport = { exportToObsidian }.
 * Depends on JSZip being loaded globally before this script.
 */
(function () {
  'use strict';

  // ── Slug generation ──────────────────────────────────────────────
  // Deterministic, URL-safe slug from a title string.
  // Matches the spec: lowercase, collapse non-alphanum to hyphens, trim, max 80 chars.
  function slugify(title) {
    return (title || 'untitled')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80);
  }

  // ── YAML frontmatter ─────────────────────────────────────────────
  // Mirrors background.js buildMarkdownContent but adds richer fields.
  function yamlEscape(str) {
    if (/[:#\[\]{}|>&*!,?'"]/.test(str) || str.trim() !== str) {
      return '"' + str.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    }
    return '"' + str.replace(/"/g, '\\"') + '"';
  }

  function buildFrontmatter(reading) {
    const lines = ['---'];
    lines.push('title: ' + yamlEscape(reading.title || 'Untitled'));
    if (reading.author) lines.push('author: ' + yamlEscape(reading.author));
    if (reading.tags && reading.tags.length) {
      lines.push('tags: [' + reading.tags.map(function (t) { return yamlEscape(t); }).join(', ') + ']');
    }
    if (reading.url) lines.push('url: ' + yamlEscape(reading.url));
    if (reading.estPages) lines.push('pages: ' + reading.estPages);
    lines.push('created: ' + yamlEscape(reading.createdAt || ''));
    lines.push('updated: ' + yamlEscape(reading.updatedAt || ''));
    lines.push('---');
    return lines.join('\n');
  }

  // ── Reading log table ────────────────────────────────────────────
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
  function buildHighlightsSection(highlights) {
    if (!highlights || !highlights.length) return '';
    var sorted = highlights.slice().sort(function (a, b) {
      return (a.pageIndex || 0) - (b.pageIndex || 0) || (a.startOffset || 0) - (b.startOffset || 0);
    });

    var lines = ['## Highlights', ''];
    for (var i = 0; i < sorted.length; i++) {
      var h = sorted[i];
      // Page marker for PDFs
      if (h.pageIndex !== undefined) {
        lines.push('*Page ' + (h.pageIndex + 1) + '*');
        lines.push('');
      }
      // Quote text — convert LaTeX delimiters for Obsidian
      var text = h.text || '';
      if (h.latex) {
        // Render inline LaTeX as $...$
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
    return lines.join('\n');
  }

  // ── Backlinks section ────────────────────────────────────────────
  // Finds other readings sharing at least one tag with this reading.
  function buildBacklinks(reading, slugMap) {
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
  function buildReadingMarkdown(reading, highlights, slugMap) {
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

    // Backlinks
    var blSection = buildBacklinks(reading, slugMap);
    if (blSection) parts.push(blSection);

    return parts.join('\n');
  }

  // ── Tag index file ──────────────────────────────────────────────
  function buildTagIndex(tag, tagSlug, readingsWithTag) {
    var lines = [
      '---',
      'tag: ' + yamlEscape(tag),
      'type: "tag-index"',
      '---',
      '',
      '# ' + tag,
      '',
      readingsWithTag.length + ' reading' + (readingsWithTag.length !== 1 ? 's' : '') + ' with this tag.',
      ''
    ];
    // Sort by title
    readingsWithTag.sort(function (a, b) {
      return (a.title || '').localeCompare(b.title || '');
    });
    for (var i = 0; i < readingsWithTag.length; i++) {
      var r = readingsWithTag[i];
      var slug = slugify(r.title);
      lines.push('- [[' + slug + '|' + (r.title || 'Untitled') + ']]');
    }
    lines.push('');
    return lines.join('\n');
  }

  // ── Master index ─────────────────────────────────────────────────
  function buildMasterIndex(readings, tagList) {
    var lines = [
      '---',
      'type: "index"',
      '---',
      '',
      '# Marginalia Reading Index',
      '',
      readings.length + ' reading' + (readings.length !== 1 ? 's' : '') + ' exported.',
      '',
      '## Readings',
      ''
    ];
    // Sort by title
    var sorted = readings.slice().sort(function (a, b) {
      return (a.title || '').localeCompare(b.title || '');
    });
    for (var i = 0; i < sorted.length; i++) {
      var r = sorted[i];
      var slug = slugify(r.title);
      var author = r.author ? ' — ' + r.author : '';
      lines.push('- [[' + slug + '|' + (r.title || 'Untitled') + ']]' + author);
    }

    if (tagList.length) {
      lines.push('');
      lines.push('## Tags');
      lines.push('');
      tagList.sort();
      for (var j = 0; j < tagList.length; j++) {
        var tSlug = slugify(tagList[j]);
        lines.push('- [[' + tSlug + '|' + tagList[j] + ']]');
      }
    }

    lines.push('');
    return lines.join('\n');
  }

  // ── Main export function ─────────────────────────────────────────
  async function exportToObsidian() {
    // 1. Load all readings
    var storageResult = await chrome.storage.local.get('ocReadings');
    var ocReadings = storageResult.ocReadings || {};
    var pageKeys = Object.keys(ocReadings);

    if (!pageKeys.length) {
      throw new Error('No readings found to export.');
    }

    // 2. Load all highlights in one batch
    var hlData = pageKeys.length ? await chrome.storage.local.get(pageKeys) : {};

    // 3. Build slug -> reading map and collect all data
    var slugMap = {};     // slug -> reading
    var readingsList = []; // array of { reading, highlights, slug }
    var tagReadings = {}; // tag -> [reading, ...]

    for (var i = 0; i < pageKeys.length; i++) {
      var pk = pageKeys[i];
      var reading = ocReadings[pk];
      var highlights = Array.isArray(hlData[pk]) ? hlData[pk] : [];
      var slug = slugify(reading.title);

      slugMap[slug] = reading;
      readingsList.push({ reading: reading, highlights: highlights, slug: slug });

      // Collect tag -> readings mapping
      if (reading.tags) {
        for (var t = 0; t < reading.tags.length; t++) {
          var tag = reading.tags[t];
          if (!tagReadings[tag]) tagReadings[tag] = [];
          tagReadings[tag].push(reading);
        }
      }
    }

    // 4. Build zip
    var zip = new JSZip();

    // Individual reading files
    for (var r = 0; r < readingsList.length; r++) {
      var entry = readingsList[r];
      var content = buildReadingMarkdown(entry.reading, entry.highlights, slugMap);
      zip.file('readings/' + entry.slug + '.md', content);
    }

    // Tag index files
    var tagList = Object.keys(tagReadings);
    for (var ti = 0; ti < tagList.length; ti++) {
      var tagName = tagList[ti];
      var tagSlug = slugify(tagName);
      var tagContent = buildTagIndex(tagName, tagSlug, tagReadings[tagName]);
      zip.file('tags/' + tagSlug + '.md', tagContent);
    }

    // Master index
    var allReadingsForIndex = readingsList.map(function (e) { return e.reading; });
    zip.file('index.md', buildMasterIndex(allReadingsForIndex, tagList));

    // 5. Generate and trigger download
    var blob = await zip.generateAsync({ type: 'blob' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'marginalia-export-' + new Date().toISOString().slice(0, 10) + '.zip';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    return readingsList.length;
  }

  window.__marginaliaExport = { exportToObsidian: exportToObsidian };
})();

// ── State ────────────────────────────────────────────────────────────
let graphData = { nodes: [], links: [] };
let simulation = null;
let currentFilter = 'all';

const TAG_COLORS = {
  'AI/ML Research': '#e8a87c',
  'Healthcare/Bio': '#6fcf97',
  'Philosophy': '#bb6bd9',
  'Economics/Finance': '#64b5f6',
  'Research Craft': '#f06292',
  'General Learning': '#888',
};

const TYPE_COLORS = {
  theory: '#e8a87c',
  method: '#6fcf97',
  person: '#64b5f6',
  field: '#bb6bd9',
  tool: '#f06292',
  dataset: '#ffa726',
  finding: '#4dd0e1',
};

// ── DOM refs ────────────────────────────────────────────────────────
const svg = d3.select('#graph-svg');
const tooltip = document.getElementById('tooltip');
const statusText = document.getElementById('status-text');
const detailPanel = document.getElementById('detail-panel');

// ── Init ─────────────────────────────────────────────────────────────
loadAndRender();

document.getElementById('btn-extract-all').addEventListener('click', extractAll);
document.getElementById('btn-refresh').addEventListener('click', loadAndRender);
document.getElementById('detail-close').addEventListener('click', () => {
  detailPanel.classList.remove('open');
});
document.getElementById('filter-select').addEventListener('change', e => {
  currentFilter = e.target.value;
  renderGraph();
});

// ── Load data and render ─────────────────────────────────────────────
async function loadAndRender() {
  statusText.textContent = 'Loading...';

  const [conceptData, readingsData] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'oc-get-concepts' }),
    chrome.storage.local.get('ocReadings')
  ]);

  const concepts = conceptData || { readings: {}, edges: [] };
  const readings = readingsData.ocReadings || {};

  buildGraphData(readings, concepts);
  renderGraph();

  const readingCount = Object.keys(readings).length;
  const conceptCount = graphData.nodes.filter(n => n.nodeType === 'concept').length;
  const extractedCount = Object.keys(concepts.readings || {}).length;
  statusText.textContent = `${readingCount} readings, ${conceptCount} concepts, ${extractedCount} extracted`;
}

// ── Build graph data ─────────────────────────────────────────────────
function buildGraphData(readings, concepts) {
  const nodes = [];
  const links = [];
  const conceptSet = new Map(); // name → node

  // Add reading nodes
  for (const [key, reading] of Object.entries(readings)) {
    const tag = reading.tags?.[0] || 'General Learning';
    nodes.push({
      id: key,
      label: truncate(reading.title || key, 30),
      fullTitle: reading.title || key,
      nodeType: 'reading',
      color: TAG_COLORS[tag] || TAG_COLORS['General Learning'],
      radius: 8,
      reading,
      concepts: concepts.readings?.[key]?.concepts || [],
      domains: concepts.readings?.[key]?.domains || [],
      extracted: !!concepts.readings?.[key]
    });

    // Add concept nodes and links
    const readingConcepts = concepts.readings?.[key]?.concepts || [];
    for (const concept of readingConcepts) {
      const cKey = concept.name.toLowerCase();
      if (!conceptSet.has(cKey)) {
        const cNode = {
          id: `concept:${cKey}`,
          label: concept.name,
          fullTitle: concept.name,
          nodeType: 'concept',
          color: TYPE_COLORS[concept.type] || '#888',
          radius: 5,
          conceptType: concept.type,
          mentionedBy: [key]
        };
        conceptSet.set(cKey, cNode);
        nodes.push(cNode);
      } else {
        conceptSet.get(cKey).mentionedBy.push(key);
      }

      links.push({
        source: key,
        target: `concept:${cKey}`,
        type: 'mention'
      });
    }
  }

  // Add reading↔reading edges for shared concepts
  for (const edge of (concepts.edges || [])) {
    links.push({
      source: edge.source,
      target: edge.target,
      type: 'shared',
      shared: edge.shared
    });
  }

  graphData = { nodes, links };
}

// ── Render graph with D3 force simulation ────────────────────────────
function renderGraph() {
  svg.selectAll('*').remove();

  const width = window.innerWidth;
  const height = window.innerHeight - 90;

  let filteredNodes = graphData.nodes;
  let filteredLinks = graphData.links;

  if (currentFilter === 'readings') {
    filteredNodes = graphData.nodes.filter(n => n.nodeType === 'reading');
    filteredLinks = graphData.links.filter(l => l.type === 'shared');
  } else if (currentFilter === 'concepts') {
    filteredNodes = graphData.nodes.filter(n => n.nodeType === 'concept');
    filteredLinks = [];
  }

  if (!filteredNodes.length) {
    svg.append('text')
      .attr('x', width / 2).attr('y', height / 2)
      .attr('text-anchor', 'middle')
      .attr('fill', '#555').attr('font-size', '14px')
      .text('No data yet. Click "Extract All" to analyze your readings.');
    return;
  }

  // Resolve link references to objects
  const nodeById = new Map(filteredNodes.map(n => [n.id, n]));
  const resolvedLinks = filteredLinks.filter(l => {
    const sid = typeof l.source === 'object' ? l.source.id : l.source;
    const tid = typeof l.target === 'object' ? l.target.id : l.target;
    return nodeById.has(sid) && nodeById.has(tid);
  }).map(l => ({
    ...l,
    source: typeof l.source === 'object' ? l.source.id : l.source,
    target: typeof l.target === 'object' ? l.target.id : l.target,
  }));

  const g = svg.append('g');

  // Zoom behavior
  const zoom = d3.zoom()
    .scaleExtent([0.1, 4])
    .on('zoom', e => g.attr('transform', e.transform));
  svg.call(zoom);

  // Links
  const link = g.append('g')
    .selectAll('line')
    .data(resolvedLinks)
    .join('line')
    .attr('class', d => d.type === 'shared' ? 'edge edge-shared' : 'edge')
    .attr('stroke-width', d => d.type === 'shared' ? 2 : 1);

  // Nodes
  const node = g.append('g')
    .selectAll('circle')
    .data(filteredNodes)
    .join('circle')
    .attr('r', d => d.radius)
    .attr('fill', d => d.color)
    .attr('stroke', '#0a0a0a')
    .attr('stroke-width', 1.5)
    .attr('cursor', 'pointer')
    .call(d3.drag()
      .on('start', dragStart)
      .on('drag', dragging)
      .on('end', dragEnd)
    )
    .on('mouseover', (event, d) => showTooltip(event, d))
    .on('mouseout', () => hideTooltip())
    .on('click', (event, d) => showDetail(d));

  // Labels
  const label = g.append('g')
    .selectAll('text')
    .data(filteredNodes.filter(n => n.nodeType === 'reading'))
    .join('text')
    .attr('class', 'node-label node-label-reading')
    .attr('dy', d => d.radius + 14)
    .text(d => d.label);

  // Simulation
  simulation = d3.forceSimulation(filteredNodes)
    .force('link', d3.forceLink(resolvedLinks).id(d => d.id).distance(80))
    .force('charge', d3.forceManyBody().strength(-150))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collision', d3.forceCollide().radius(d => d.radius + 5))
    .on('tick', () => {
      link
        .attr('x1', d => d.source.x)
        .attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x)
        .attr('y2', d => d.target.y);
      node
        .attr('cx', d => d.x)
        .attr('cy', d => d.y);
      label
        .attr('x', d => d.x)
        .attr('y', d => d.y);
    });
}

// ── Drag handlers ────────────────────────────────────────────────────
function dragStart(event, d) {
  if (!event.active) simulation.alphaTarget(0.3).restart();
  d.fx = d.x;
  d.fy = d.y;
}

function dragging(event, d) {
  d.fx = event.x;
  d.fy = event.y;
}

function dragEnd(event, d) {
  if (!event.active) simulation.alphaTarget(0);
  d.fx = null;
  d.fy = null;
}

// ── Tooltip ──────────────────────────────────────────────────────────
function showTooltip(event, d) {
  let html = `<strong>${escHtml(d.fullTitle)}</strong>`;
  if (d.nodeType === 'concept') {
    html += `<br><span style="color:#888">${d.conceptType || ''}</span>`;
    if (d.mentionedBy?.length) {
      html += `<br>${d.mentionedBy.length} reading${d.mentionedBy.length !== 1 ? 's' : ''}`;
    }
  } else if (d.nodeType === 'reading') {
    if (d.reading?.author) html += `<br>${escHtml(d.reading.author)}`;
    if (d.concepts.length) html += `<br>${d.concepts.length} concept${d.concepts.length !== 1 ? 's' : ''}`;
    if (!d.extracted) html += `<br><em style="color:#666">Not yet extracted</em>`;
  }

  tooltip.innerHTML = html;
  tooltip.style.display = 'block';
  tooltip.style.left = (event.clientX + 12) + 'px';
  tooltip.style.top = (event.clientY + 12) + 'px';
}

function hideTooltip() {
  tooltip.style.display = 'none';
}

// ── Detail panel ─────────────────────────────────────────────────────
function showDetail(d) {
  detailPanel.classList.add('open');
  document.getElementById('detail-title').textContent = d.fullTitle;

  if (d.nodeType === 'reading') {
    const r = d.reading;
    document.getElementById('detail-meta').innerHTML = [
      r.author ? `Author: ${escHtml(r.author)}` : '',
      r.tags?.length ? `Tags: ${r.tags.join(', ')}` : '',
      r.estPages ? `${r.estPages} pages` : '',
      d.domains?.length ? `Domains: ${d.domains.join(', ')}` : '',
    ].filter(Boolean).join('<br>');

    const list = document.getElementById('detail-concepts');
    list.innerHTML = d.concepts.map(c =>
      `<li>${escHtml(c.name)} <span class="concept-type">${c.type}</span></li>`
    ).join('') || '<li style="color:#555">No concepts extracted yet</li>';
  } else {
    document.getElementById('detail-meta').textContent =
      `Type: ${d.conceptType || 'unknown'} | Mentioned in ${d.mentionedBy?.length || 0} reading(s)`;
    document.getElementById('detail-concepts').innerHTML = '';
  }
}

// ── Extract all ──────────────────────────────────────────────────────
async function extractAll() {
  const btn = document.getElementById('btn-extract-all');
  btn.disabled = true;
  btn.textContent = 'Extracting...';
  statusText.textContent = 'Extracting concepts...';

  try {
    const { ocReadings = {} } = await chrome.storage.local.get('ocReadings');
    const pageKeys = Object.keys(ocReadings);

    if (!pageKeys.length) {
      statusText.textContent = 'No readings to extract from';
      return;
    }

    const result = await chrome.runtime.sendMessage({
      type: 'oc-extract-concepts-batch',
      pageKeys
    });

    if (result.error) {
      statusText.textContent = `Error: ${result.error}`;
    } else {
      statusText.textContent = `Extracted: ${result.extracted}, Skipped: ${result.skipped}, Failed: ${result.failed}`;
      await loadAndRender();
    }
  } catch (e) {
    statusText.textContent = `Error: ${e.message}`;
  }

  btn.disabled = false;
  btn.textContent = 'Extract All';
}

// ── Utility ──────────────────────────────────────────────────────────
function escHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function truncate(str, len) {
  return str.length > len ? str.slice(0, len) + '...' : str;
}

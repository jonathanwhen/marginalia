// lib/classify.js — Keyword-based auto-classification for readings
//
// Scores title + URL + content against weighted keyword lists to assign
// the best-matching category tag. Falls back to 'General Learning' when
// no category scores above the confidence threshold.
//
// Design: keyword matching over LLM calls — instant, free, offline,
// and ~80%+ accurate for well-defined content categories. Intent-based
// tags like 'To Revisit' stay manual.

const CATEGORIES = {
  'AI/ML Research': {
    titleKeywords: [
      'neural', 'transformer', 'language model', 'llm', 'gpt', 'bert',
      'diffusion', 'attention mechanism', 'reinforcement learning',
      'machine learning', 'deep learning', 'embedding', 'tokenizer',
      'fine-tuning', 'fine tuning', 'rlhf', 'pretraining', 'pre-training',
      'inference', 'scaling law', 'gradient', 'backprop', 'generative',
      'autoregressive', 'world model', 'benchmark', 'latent space',
      'representation learning', 'self-supervised', 'contrastive learning',
      'few-shot', 'zero-shot', 'in-context learning', 'chain of thought',
      'alignment', 'reward model', 'multimodal', 'convolution', 'recurrent',
      'lstm', 'gan', 'vae', 'variational', 'mixture of experts', 'moe',
      'distillation', 'quantization', 'open source model', 'open-source model',
      'artificial intelligence', 'computer vision', 'natural language',
      'text generation', 'image generation', 'speech recognition',
      'robot', 'autonomous', 'self-driving'
    ],
    urlPatterns: [
      'arxiv.org', 'openreview.net', 'proceedings.mlr.press',
      'anthropic.com/research', 'openai.com/research', 'deepmind',
      'huggingface', 'proceedings.neurips.cc', 'iclr-blogposts'
    ],
    contentKeywords: [
      'neural network', 'backpropagation', 'stochastic gradient',
      'cross-entropy', 'softmax', 'relu', 'batch normalization', 'dropout',
      'attention head', 'positional encoding', 'causal mask',
      'next token prediction', 'perplexity', 'ablation study',
      'hyperparameter', 'learning rate', 'minibatch', 'overfitting',
      'validation set', 'loss function', 'optimizer'
    ]
  },

  'Healthcare/Bio': {
    titleKeywords: [
      'health', 'medical', 'clinical', 'patient', 'drug', 'gene', 'protein',
      'biology', 'cancer', 'therapy', 'diagnosis', 'pharmaceutical', 'biotech',
      'genomic', 'neuroscience', 'brain tumor', 'disease', 'treatment',
      'cell', 'dna', 'rna', 'hospital', 'symptom', 'vaccine', 'immune',
      'surgical', 'pathology', 'epidemiology', 'public health', 'mental health',
      'brain-computer', 'bci', 'neuroprosthetic', 'bioinformatics', 'healthcare',
      'cure', 'tumor', 'organ', 'anatomy', 'physiology', 'longevity'
    ],
    urlPatterns: [
      'pubmed', 'nih.gov', 'nature.com/nature-medicine', 'thelancet',
      'nejm.org', 'biorxiv.org', 'medrxiv.org'
    ],
    contentKeywords: [
      'clinical trial', 'placebo', 'double-blind', 'cohort', 'randomized',
      'dosage', 'side effect', 'fda approved', 'medication', 'prognosis',
      'mortality', 'morbidity', 'therapeutic', 'pathogen', 'antibody',
      'blood pressure', 'heart rate', 'white blood cell'
    ]
  },

  'Philosophy': {
    titleKeywords: [
      'philosophy', 'philosopher', 'nietzsche', 'kant', 'plato', 'aristotle',
      'existential', 'meaning of life', 'ethics', 'moral', 'consciousness',
      'soul', 'death', 'suffering', 'virtue', 'stoic', 'stoicism',
      'good and evil', 'evil', 'nihilism', 'absurd', 'camus', 'sartre',
      'heidegger', 'kierkegaard', 'ubermenschen', 'metaphysics', 'ontology',
      'epistemology', 'theology', 'divine', 'spiritual', 'wisdom',
      'free will', 'determinism', 'utilitarianism', 'phenomenology',
      'dialectic', 'socratic', 'transcendence', 'human condition',
      'memento mori', 'memento', 'amor fati', 'adversity', 'overcome',
      'what it means', 'god died'
    ],
    urlPatterns: [
      'plato.stanford.edu', 'philosophynow.org'
    ],
    contentKeywords: [
      'categorical imperative', 'will to power', 'eternal recurrence',
      'being and nothingness', 'cave allegory', 'cogito ergo sum',
      'the good life', 'eudaimonia', 'telos', 'logos', 'human nature',
      'moral philosophy', 'the sublime', 'aesthetic experience'
    ]
  },

  'Economics/Finance': {
    titleKeywords: [
      'economy', 'economic', 'market', 'stock', 'bond', 'inflation', 'gdp',
      'trade', 'tariff', 'fiscal', 'monetary', 'investment', 'capital',
      'hedge fund', 'bridgewater', 'macro', 'bubble', 'financial', 'bank',
      'interest rate', 'supply chain', 'demographics', 'geopolitical',
      'friedman', 'shareholder', 'capex', 'valuation', 'equity', 'debt',
      'recession', 'growth', 'productivity', 'globalization', 'mercantilism',
      'central bank', 'yield', 'portfolio', 'venture', 'startup',
      'private equity', 'business model', 'revenue', 'crisis',
      'global outlook', 'deep dive on us', 'patient capital'
    ],
    urlPatterns: [
      'bridgewater.com', 'bloomberg.com', 'ft.com', 'economist.com',
      'wsj.com', 'federalreserve.gov', 'citriniresearch.com'
    ],
    contentKeywords: [
      'interest rate', 'federal reserve', 'quantitative easing', 'balance sheet',
      'bull market', 'bear market', 'price earnings', 'market cap',
      'gdp growth', 'consumer spending', 'unemployment rate',
      'monetary policy', 'fiscal stimulus'
    ]
  },

  'Research Craft': {
    // Slightly higher weight so it can win over AI/ML for methodology-focused articles
    weight: 1.3,
    titleKeywords: [
      'effective research', 'your research', 'research career', 'phd',
      'how to research', 'principles of research', 'opinionated guide',
      'scientific method', 'peer review', 'research taste', 'academia',
      'publishing', 'dissertation', 'thesis', 'academic life',
      'mentor', 'scholarship', 'inquiry', 'methodology',
      'how to learn', 'how to study', 'how to read', 'learning strategy'
    ],
    urlPatterns: [],
    contentKeywords: [
      'research agenda', 'open problems', 'research question',
      'literature review', 'state of the art', 'foundational learning',
      'reading papers', 'research directions', 'taste in research'
    ]
  }
};

const DEFAULT_TAG = 'General Learning';

// Word-boundary matching for single-word keywords to prevent false positives
// like "bert" matching "robert" or "thesis" matching "hypothesis".
// Multi-word phrases use simple substring matching (inherently specific enough).
function matchKeyword(text, keyword) {
  if (keyword.includes(' ')) return text.includes(keyword);
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}`).test(text);
}

/**
 * Classify a reading into the best-matching category.
 *
 * Scoring: title keywords = 3pts, URL patterns = 4pts,
 * content keywords = 1pt, title keywords in content = 0.5pts.
 * Minimum threshold of 2.5 points to avoid false positives.
 *
 * @param {string} title  - Reading title
 * @param {string} url    - Source URL
 * @param {string} content - Plain text content (first ~3000 chars used)
 * @returns {string} Best-matching category tag
 */
export function classifyReading(title, url, content) {
  const titleLower = (title || '').toLowerCase();
  const urlLower = (url || '').toLowerCase();
  const contentSample = (content || '').toLowerCase().slice(0, 3000);

  const scores = {};

  for (const [category, config] of Object.entries(CATEGORIES)) {
    let score = 0;

    // Title keyword matches (strongest signal — titles are concise and descriptive)
    for (const kw of config.titleKeywords) {
      if (matchKeyword(titleLower, kw)) score += 3;
    }

    // URL pattern matches (very reliable — arxiv.org = research paper)
    for (const pattern of (config.urlPatterns || [])) {
      if (urlLower.includes(pattern)) score += 4;
    }

    // Content keyword matches (weaker signal — more noise in body text)
    for (const kw of (config.contentKeywords || [])) {
      if (matchKeyword(contentSample, kw)) score += 1;
    }

    // Title keywords found in content (medium signal)
    for (const kw of config.titleKeywords) {
      if (matchKeyword(contentSample, kw)) score += 0.5;
    }

    scores[category] = score * (config.weight || 1);
  }

  // Pick the highest-scoring category above the confidence threshold.
  // Threshold of 2.5 means at least one title keyword match (3pts) or
  // a URL pattern match (4pts) is needed to trigger classification.
  let best = DEFAULT_TAG;
  let bestScore = 2.5;

  for (const [category, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      best = category;
    }
  }

  return best;
}

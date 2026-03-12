/**
 * context-injector.mjs — Re-inject relevant context after compaction
 *
 * Selects the most relevant past knowledge for the current task,
 * formats it so it fits inside a system-reminder block, and respects
 * a token budget to keep injections lean.
 */

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

const AVG_CHARS_PER_TOKEN = 4; // conservative average for English + code

/**
 * Rough token count — ~4 chars per token.
 * @param {string|Array} entries — text or array of knowledge entries
 * @returns {number}
 */
export function estimateTokens(entries) {
  const text =
    typeof entries === 'string'
      ? entries
      : entries.map((e) => JSON.stringify(e)).join('\n');
  return Math.ceil(text.length / AVG_CHARS_PER_TOKEN);
}

// ---------------------------------------------------------------------------
// Relevance scoring
// ---------------------------------------------------------------------------

function tokenize(text) {
  return (text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);
}

function jaccardSimilarity(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = [...setA].filter((x) => setB.has(x));
  const union = new Set([...setA, ...setB]);
  return union.size === 0 ? 0 : intersection.length / union.size;
}

function recencyBoost(entry) {
  const updated = entry.metadata?.updatedAt ?? entry.ts;
  if (!updated) return 0;
  const age = Date.now() - new Date(updated).getTime();
  const hours = age / 3_600_000;
  return Math.max(0, 1 - hours / 168); // decays over 1 week
}

function scoreEntry(entry, taskTokens) {
  const entryText =
    typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value ?? entry);
  const entryTokens = tokenize(entryText + ' ' + (entry.key ?? ''));

  const similarity = jaccardSimilarity(taskTokens, entryTokens);
  const recency = recencyBoost(entry);
  const pinned = entry.metadata?.pinned ? 0.3 : 0;

  return similarity * 0.5 + recency * 0.3 + pinned + 0.01; // baseline 0.01
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Pick the most relevant past context for the current task.
 * @param {string} currentTask — description of current task
 * @param {Array}  knowledge   — array of knowledge entries
 * @param {number} [topK=10]   — max entries to return
 * @returns {Array} sorted by relevance (highest first)
 */
export function selectRelevant(currentTask, knowledge, topK = 10) {
  try {
    if (!currentTask || typeof currentTask !== 'string') {
      return [];
    }
    if (!Array.isArray(knowledge)) {
      return [];
    }

    const taskTokens = tokenize(currentTask);

    return [...knowledge]
      .map((entry) => ({ entry, score: scoreEntry(entry, taskTokens) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((item) => item.entry);
  } catch (err) {
    console.warn(`Error selecting relevant context: ${err.message}`);
    return [];
  }
}

/**
 * Format entries as system-reminder compatible text.
 * @param {Array} entries — knowledge entries
 * @returns {string}
 */
export function formatForInjection(entries) {
  try {
    if (!Array.isArray(entries) || entries.length === 0) return '';

    const lines = ['<system-reminder>', '# Nexus — Restored Context', ''];

    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;

      const key = entry.key ?? entry.id ?? 'unknown';
      const value =
        typeof entry.value === 'string'
          ? entry.value
          : JSON.stringify(entry.value ?? entry, null, 2);
      lines.push(`## ${key}`);
      lines.push(value);
      lines.push('');
    }

    lines.push('</system-reminder>');
    return lines.join('\n');
  } catch (err) {
    console.warn(`Error formatting injection: ${err.message}`);
    return '';
  }
}

/**
 * Apply relevance decay to entries based on age and access patterns.
 * @param {Array} entries — knowledge entries
 * @param {object} [options] — decay options
 * @param {number} [options.maxAge=604800000] — max age in ms (default 7 days)
 * @param {number} [options.decayRate=0.1] — decay rate per day (0-1)
 * @param {boolean} [options.preservePinned=true] — don't decay pinned entries
 * @returns {Array} — entries with decayedScore added
 */
export function applyRelevanceDecay(entries, options = {}) {
  try {
    const {
      maxAge = 604_800_000, // 7 days in ms
      decayRate = 0.1,
      preservePinned = true,
    } = options;

    if (!Array.isArray(entries)) {
      return [];
    }

    const now = Date.now();

    return entries.map((entry) => {
      if (!entry || typeof entry !== 'object') return entry;

      // Preserve pinned entries if option is set
      if (preservePinned && entry.metadata?.pinned) {
        return { ...entry, decayedScore: 1.0 };
      }

      const updated = entry.metadata?.updatedAt ?? entry.ts;
      if (!updated) {
        return { ...entry, decayedScore: 0.5 }; // neutral for unknown age
      }

      const age = now - new Date(updated).getTime();
      const ageDays = age / 86_400_000; // ms to days

      // Exponential decay: score = e^(-decayRate * days)
      const decayFactor = Math.exp(-decayRate * ageDays);

      // If older than maxAge, apply additional penalty
      const agePenalty = age > maxAge ? 0.5 : 1.0;

      const decayedScore = Math.max(0, Math.min(1, decayFactor * agePenalty));

      return { ...entry, decayedScore };
    });
  } catch (err) {
    console.warn(`Error applying relevance decay: ${err.message}`);
    return entries;
  }
}

/**
 * Re-rank entries by combining their existing relevance score with decay.
 * @param {Array} entries — entries with optional score field
 * @param {object} [decayOptions] — options for applyRelevanceDecay
 * @returns {Array} — re-ranked entries sorted by combined score
 */
export function reRankWithDecay(entries, decayOptions = {}) {
  try {
    if (!Array.isArray(entries)) {
      return [];
    }

    const decayed = applyRelevanceDecay(entries, decayOptions);

    return decayed
      .map((entry) => {
        const baseScore = entry.score ?? entry.importance ?? 0.5;
        const decayScore = entry.decayedScore ?? 0.5;
        const combinedScore = baseScore * 0.6 + decayScore * 0.4;
        return { ...entry, combinedScore };
      })
      .sort((a, b) => (b.combinedScore ?? 0) - (a.combinedScore ?? 0));
  } catch (err) {
    console.warn(`Error re-ranking with decay: ${err.message}`);
    return entries;
  }
}

/**
 * Get the effective age weight for an entry (higher = more recent).
 * @param {object} entry — knowledge entry
 * @param {number} [halfLife=7] — half-life in days for decay
 * @returns {number} — weight between 0 and 1
 */
export function getAgeWeight(entry, halfLife = 7) {
  try {
    if (!entry || typeof entry !== 'object') {
      return 0.5;
    }

    const updated = entry.metadata?.updatedAt ?? entry.ts;
    if (!updated) return 0.5;

    const age = Date.now() - new Date(updated).getTime();
    const ageDays = age / 86_400_000;

    // Half-life decay: weight = 0.5^(age / halfLife)
    return Math.pow(0.5, ageDays / halfLife);
  } catch (err) {
    console.warn(`Error calculating age weight: ${err.message}`);
    return 0.5;
  }
}

/**
 * Create an injection payload that fits within a token budget.
 * @param {Array}  entries   — knowledge entries (pre-sorted by relevance)
 * @param {number} maxTokens — token budget (default 2000)
 * @returns {{payload:string, included:number, estimatedTokens:number}}
 */
export function inject(entries, maxTokens = 2000) {
  try {
    if (!Array.isArray(entries)) {
      entries = [];
    }

    const included = [];
    let budget = maxTokens;

    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;

      const cost = estimateTokens([entry]);
      if (cost > budget) continue;
      included.push(entry);
      budget -= cost;
    }

    const payload = formatForInjection(included);
    return {
      payload,
      included: included.length,
      estimatedTokens: estimateTokens(payload),
    };
  } catch (err) {
    console.warn(`Error creating injection: ${err.message}`);
    return {
      payload: '',
      included: 0,
      estimatedTokens: 0,
    };
  }
}

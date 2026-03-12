/**
 * compaction-monitor.mjs — Monitor and predict context compaction
 *
 * Estimates token usage, predicts when compaction will occur, and
 * provides risk levels plus suggestions for pre-emptive compaction.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AVG_CHARS_PER_TOKEN = 4;
const DEFAULT_CONTEXT_LIMIT = 200_000; // 200k tokens — typical large-context model

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Estimate token usage for an array of messages.
 * @param {Array<{role:string, content:string}>} messages
 * @returns {{tokens:number, chars:number, messageCount:number}}
 */
export function estimateTokenUsage(messages) {
  try {
    if (!Array.isArray(messages)) {
      return { tokens: 0, chars: 0, messageCount: 0 };
    }

    let chars = 0;
    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') continue;

      const content = msg.content ?? '';
      if (typeof content === 'string') {
        chars += content.length;
      }
      // Role overhead ≈ 4 tokens per message
    }
    const overhead = messages.length * 16; // ~4 tokens * 4 chars
    const totalChars = chars + overhead;
    return {
      tokens: Math.ceil(totalChars / AVG_CHARS_PER_TOKEN),
      chars: totalChars,
      messageCount: messages.length,
    };
  } catch (err) {
    console.warn(`Error estimating token usage: ${err.message}`);
    return { tokens: 0, chars: 0, messageCount: 0 };
  }
}

/**
 * Predict when compaction will hit based on current usage and growth rate.
 * @param {Array<{role:string, content:string}>} messages — current messages
 * @param {number} [rate] — tokens per message (auto-calculated if omitted)
 * @param {number} [contextLimit] — model context limit in tokens
 * @returns {{currentTokens:number, limit:number, tokensRemaining:number, messagesUntilCompaction:number, percentUsed:number}}
 */
export function predictCompaction(messages, rate, contextLimit = DEFAULT_CONTEXT_LIMIT) {
  try {
    if (!Array.isArray(messages)) {
      messages = [];
    }

    if (typeof contextLimit !== 'number' || contextLimit <= 0) {
      contextLimit = DEFAULT_CONTEXT_LIMIT;
    }

    const { tokens } = estimateTokenUsage(messages);

    if (!rate && messages.length > 1) {
      rate = tokens / messages.length;
    }
    rate = rate || 500; // fallback

    const remaining = Math.max(0, contextLimit - tokens);
    const messagesLeft = rate > 0 ? Math.floor(remaining / rate) : Infinity;

    return {
      currentTokens: tokens,
      limit: contextLimit,
      tokensRemaining: remaining,
      messagesUntilCompaction: messagesLeft,
      percentUsed: Math.round((tokens / contextLimit) * 100),
    };
  } catch (err) {
    console.warn(`Error predicting compaction: ${err.message}`);
    return {
      currentTokens: 0,
      limit: contextLimit,
      tokensRemaining: contextLimit,
      messagesUntilCompaction: Infinity,
      percentUsed: 0,
    };
  }
}

/**
 * Get a risk level for compaction.
 * @param {Array<{role:string, content:string}>} [messages]
 * @param {number} [contextLimit]
 * @returns {'low'|'medium'|'high'|'critical'}
 */
export function getCompactionRisk(messages = [], contextLimit = DEFAULT_CONTEXT_LIMIT) {
  try {
    if (!Array.isArray(messages)) {
      messages = [];
    }

    if (typeof contextLimit !== 'number' || contextLimit <= 0) {
      contextLimit = DEFAULT_CONTEXT_LIMIT;
    }

    const { tokens } = estimateTokenUsage(messages);
    const pct = tokens / contextLimit;

    if (pct >= 0.9) return 'critical';
    if (pct >= 0.7) return 'high';
    if (pct >= 0.5) return 'medium';
    return 'low';
  } catch (err) {
    console.warn(`Error getting compaction risk: ${err.message}`);
    return 'low';
  }
}

/**
 * Create a text-based progress bar for terminal display.
 * @param {number} percent — completion percentage (0-100)
 * @param {number} [width=40] — width of progress bar in characters
 * @param {object} [options] — display options
 * @param {boolean} [options.showPercent=true] — show percentage
 * @param {boolean} [options.showBar=true] — show bar
 * @param {string} [options.fillChar='█'] — character for filled portion
 * @param {string} [options.emptyChar='░'] — character for empty portion
 * @param {string} [options.label=''] — optional label
 * @returns {string} — formatted progress bar
 */
export function createProgressBar(percent, width = 40, options = {}) {
  try {
    const {
      showPercent = true,
      showBar = true,
      fillChar = '█',
      emptyChar = '░',
      label = '',
    } = options;

    if (typeof percent !== 'number') percent = 0;
    percent = Math.max(0, Math.min(100, percent));

    const parts = [];

    if (label) {
      parts.push(label);
    }

    if (showBar) {
      const filled = Math.round((percent / 100) * width);
      const empty = width - filled;
      const bar = fillChar.repeat(filled) + emptyChar.repeat(empty);
      parts.push(`[${bar}]`);
    }

    if (showPercent) {
      parts.push(`${Math.round(percent)}%`);
    }

    return parts.join(' ');
  } catch (err) {
    console.warn(`Error creating progress bar: ${err.message}`);
    return `[Error: ${percent}%]`;
  }
}

/**
 * Create a visual progress indicator for compaction monitoring.
 * @param {Array<{role:string, content:string}>} messages — current messages
 * @param {number} [contextLimit] — context limit in tokens
 * @param {object} [options] — display options for progress bar
 * @returns {{bar:string, risk:string, details:object}}
 */
export function visualizeCompactionProgress(messages, contextLimit = DEFAULT_CONTEXT_LIMIT, options = {}) {
  try {
    if (!Array.isArray(messages)) {
      messages = [];
    }

    const prediction = predictCompaction(messages, undefined, contextLimit);
    const risk = getCompactionRisk(messages, contextLimit);

    // Color-coded label based on risk
    const riskLabels = {
      low: 'Safe',
      medium: 'Moderate',
      high: 'Warning',
      critical: 'CRITICAL',
    };

    const label = `Context Usage (${riskLabels[risk] ?? 'Unknown'})`;
    const bar = createProgressBar(prediction.percentUsed, 40, { ...options, label });

    return {
      bar,
      risk,
      details: prediction,
    };
  } catch (err) {
    console.warn(`Error visualizing compaction progress: ${err.message}`);
    return {
      bar: '[Error]',
      risk: 'low',
      details: {},
    };
  }
}

/**
 * Create a multi-line progress report with detailed statistics.
 * @param {Array<{role:string, content:string}>} messages — current messages
 * @param {number} [contextLimit] — context limit in tokens
 * @returns {string} — formatted multi-line report
 */
export function createProgressReport(messages, contextLimit = DEFAULT_CONTEXT_LIMIT) {
  try {
    if (!Array.isArray(messages)) {
      messages = [];
    }

    const { bar, risk, details } = visualizeCompactionProgress(messages, contextLimit);
    const lines = [
      '',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '  Context Compaction Monitor',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '',
      `  ${bar}`,
      '',
      `  Current Usage:   ${details.currentTokens?.toLocaleString() ?? 0} tokens`,
      `  Limit:           ${details.limit?.toLocaleString() ?? 0} tokens`,
      `  Remaining:       ${details.tokensRemaining?.toLocaleString() ?? 0} tokens`,
      `  Messages:        ${details.messageCount ?? messages.length}`,
      `  Until Compact:   ~${details.messagesUntilCompaction ?? 0} messages`,
      `  Risk Level:      ${risk.toUpperCase()}`,
      '',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '',
    ];

    return lines.join('\n');
  } catch (err) {
    console.warn(`Error creating progress report: ${err.message}`);
    return `[Error creating report: ${err.message}]`;
  }
}

/**
 * Suggest a compaction strategy based on a focus area.
 * @param {string} focus — e.g. 'decisions', 'code', 'all'
 * @returns {{strategy:string, keep:string[], compact:string[]}}
 */
export function suggestCompaction(focus = 'all') {
  try {
    if (typeof focus !== 'string') {
      focus = 'all';
    }

    const strategies = {
      decisions: {
        strategy: 'Preserve decisions, compact code diffs and exploration.',
        keep: ['decisions', 'patterns', 'active-tasks'],
        compact: ['code-exploration', 'tool-outputs', 'completed-tasks'],
      },
      code: {
        strategy: 'Preserve code changes, compact discussion and reasoning.',
        keep: ['code-changes', 'file-list', 'active-tasks'],
        compact: ['discussion', 'decisions-rationale', 'exploration'],
      },
      tasks: {
        strategy: 'Preserve task state, compact everything else.',
        keep: ['active-tasks', 'blocked-tasks', 'decisions'],
        compact: ['completed-tasks', 'code-exploration', 'discussion'],
      },
      all: {
        strategy: 'Balanced compaction — keep summaries of everything.',
        keep: ['decisions', 'active-tasks', 'code-change-summaries', 'patterns'],
        compact: ['verbose-tool-output', 'exploration', 'completed-tasks'],
      },
    };

    return strategies[focus] ?? strategies.all;
  } catch (err) {
    console.warn(`Error suggesting compaction: ${err.message}`);
    return {
      strategy: 'Balanced compaction — keep summaries of everything.',
      keep: ['decisions', 'active-tasks', 'code-change-summaries', 'patterns'],
      compact: ['verbose-tool-output', 'exploration', 'completed-tasks'],
    };
  }
}

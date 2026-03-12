/**
 * context-extractor.mjs — Extract knowledge before compaction
 *
 * Parses conversation messages to pull out decisions, code changes,
 * behavioral patterns, tasks, and full snapshots so nothing is lost
 * when the context window compacts.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DECISION_SIGNALS = [
  /\b(?:decided|decision|chose|chosen|agreed|confirmed|going with|settled on|picked|opted)\b/i,
  /\b(?:let'?s go with|we(?:'ll| will) use|the plan is)\b/i,
];

const CODE_CHANGE_SIGNALS = [
  /\b(?:created|modified|edited|wrote|updated|deleted|renamed|moved|refactored)\b.*\b(?:file|module|component|function|class)\b/i,
  /(?:Write|Edit|Read)\s+(?:tool|→)/i,
  /^\s*[-+]{3}\s+[ab]\//m,                       // unified diff header
  /\b[\w/.-]+\.\w{1,6}(?::\d+)?\b/,              // file path with optional line
];

const PATTERN_SIGNALS = [
  /\b(?:always|never|prefer|convention|pattern|rule|style|approach)\b/i,
  /\b(?:we use|project uses|codebase uses|standard is)\b/i,
];

const TASK_SIGNALS = [
  /\b(?:TODO|FIXME|HACK|todo|task|next step|remaining|pending|blocked)\b/i,
  /\[[ x]]\s/i,
];

function matchesAny(text, patterns) {
  return patterns.some((p) => p.test(text));
}

function timestamp() {
  return new Date().toISOString();
}

function hashContent(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Pull all decisions made in the conversation.
 * @param {Array<{role:string, content:string}>} messages
 * @returns {Array<{id:string, text:string, speaker:string, ts:string}>}
 */
export function extractDecisions(messages) {
  try {
    if (!Array.isArray(messages)) {
      return [];
    }

    const decisions = [];
    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') continue;

      const content = msg.content ?? '';
      if (typeof content !== 'string') continue;

      const lines = content.split('\n');
      for (const line of lines) {
        if (matchesAny(line, DECISION_SIGNALS)) {
          decisions.push({
            id: `dec-${hashContent(line)}`,
            text: line.trim(),
            speaker: msg.role ?? 'unknown',
            ts: msg.ts ?? timestamp(),
          });
        }
      }
    }
    return decisions;
  } catch (err) {
    console.warn(`Error extracting decisions: ${err.message}`);
    return [];
  }
}

/**
 * List all files modified with summaries.
 * @param {Array<{role:string, content:string}>} messages
 * @returns {Array<{id:string, file:string, action:string, summary:string, ts:string}>}
 */
export function extractCodeChanges(messages) {
  try {
    if (!Array.isArray(messages)) {
      return [];
    }

    const changes = [];
    const fileRe = /\b([\w/.@-]+\.\w{1,6})(?::(\d+))?\b/g;

    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') continue;

      const text = msg.content ?? '';
      if (typeof text !== 'string') continue;
      if (!matchesAny(text, CODE_CHANGE_SIGNALS)) continue;

      const lines = text.split('\n');
      for (const line of lines) {
        try {
          const files = [...line.matchAll(fileRe)].map((m) => m[1]);
          if (files.length === 0) continue;

          const actionMatch = line.match(
            /\b(created|modified|edited|wrote|updated|deleted|renamed|moved|refactored)\b/i,
          );
          const action = actionMatch ? actionMatch[1].toLowerCase() : 'touched';

          for (const file of files) {
            changes.push({
              id: `chg-${hashContent(file + line)}`,
              file,
              action,
              summary: line.trim().slice(0, 200),
              ts: msg.ts ?? timestamp(),
            });
          }
        } catch (err) {
          // Skip malformed lines
          continue;
        }
      }
    }

    // Deduplicate by file+action
    const seen = new Set();
    return changes.filter((c) => {
      const key = `${c.file}::${c.action}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  } catch (err) {
    console.warn(`Error extracting code changes: ${err.message}`);
    return [];
  }
}

/**
 * Extract behavioral patterns learned during the conversation.
 * @param {Array<{role:string, content:string}>} messages
 * @returns {Array<{id:string, pattern:string, source:string, ts:string}>}
 */
export function extractPatterns(messages) {
  try {
    if (!Array.isArray(messages)) {
      return [];
    }

    const patterns = [];
    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') continue;

      const content = msg.content ?? '';
      if (typeof content !== 'string') continue;

      const lines = content.split('\n');
      for (const line of lines) {
        if (matchesAny(line, PATTERN_SIGNALS) && line.trim().length > 15) {
          patterns.push({
            id: `pat-${hashContent(line)}`,
            pattern: line.trim(),
            source: msg.role ?? 'unknown',
            ts: msg.ts ?? timestamp(),
          });
        }
      }
    }
    return patterns;
  } catch (err) {
    console.warn(`Error extracting patterns: ${err.message}`);
    return [];
  }
}

/**
 * Extract pending and completed tasks.
 * @param {Array<{role:string, content:string}>} messages
 * @returns {Array<{id:string, task:string, status:string, ts:string}>}
 */
export function extractTasks(messages) {
  try {
    if (!Array.isArray(messages)) {
      return [];
    }

    const tasks = [];
    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') continue;

      const content = msg.content ?? '';
      if (typeof content !== 'string') continue;

      const lines = content.split('\n');
      for (const line of lines) {
        if (!matchesAny(line, TASK_SIGNALS)) continue;

        const checkboxMatch = line.match(/\[([ x])]\s*(.*)/i);
        let status = 'pending';
        let text = line.trim();

        if (checkboxMatch) {
          status = checkboxMatch[1] === 'x' ? 'completed' : 'pending';
          text = checkboxMatch[2].trim();
        } else if (/\bcompleted?\b|\bdone\b|\bfinished\b/i.test(line)) {
          status = 'completed';
        }

        if (text.length > 5) {
          tasks.push({
            id: `tsk-${hashContent(text)}`,
            task: text.slice(0, 300),
            status,
            ts: msg.ts ?? timestamp(),
          });
        }
      }
    }
    return tasks;
  } catch (err) {
    console.warn(`Error extracting tasks: ${err.message}`);
    return [];
  }
}

/**
 * Calculate importance score for an extracted item based on frequency, recency, and type.
 * @param {object} item — extracted item with optional ts, type, text/pattern/task fields
 * @param {Array} allItems — all items of the same type for frequency calculation
 * @param {string} [itemType='generic'] — type of item: 'decision', 'code', 'pattern', 'task'
 * @returns {number} — importance score (0-100)
 */
export function calculateImportance(item, allItems = [], itemType = 'generic') {
  try {
    if (!item || typeof item !== 'object') {
      return 0;
    }

    let score = 0;

    // Type-based base score (20 points)
    const typeWeights = {
      decision: 20,
      code: 15,
      pattern: 18,
      task: 12,
      generic: 10,
    };
    score += typeWeights[itemType] ?? typeWeights.generic;

    // Recency score (40 points) — recent items are more important
    const itemTime = item.ts ? new Date(item.ts).getTime() : Date.now();
    const now = Date.now();
    const ageHours = (now - itemTime) / 3_600_000;
    const recencyScore = Math.max(0, 40 * (1 - ageHours / 168)); // decays over 1 week
    score += recencyScore;

    // Frequency score (30 points) — items mentioned multiple times are more important
    if (Array.isArray(allItems) && allItems.length > 0) {
      const itemText = item.text ?? item.pattern ?? item.task ?? item.summary ?? '';
      const occurrences = allItems.filter((other) => {
        const otherText = other.text ?? other.pattern ?? other.task ?? other.summary ?? '';
        return otherText && itemText && otherText.toLowerCase().includes(itemText.toLowerCase().slice(0, 50));
      }).length;
      const frequencyScore = Math.min(30, (occurrences / allItems.length) * 100);
      score += frequencyScore;
    } else {
      score += 10; // baseline if no context
    }

    // Length penalty (10 points bonus for substantial content)
    const content = item.text ?? item.pattern ?? item.task ?? item.summary ?? '';
    if (content.length > 100) {
      score += 10;
    } else if (content.length < 20) {
      score -= 5;
    }

    return Math.max(0, Math.min(100, Math.round(score)));
  } catch (err) {
    console.warn(`Error calculating importance: ${err.message}`);
    return 50; // neutral score on error
  }
}

/**
 * Add importance scores to all extracted items in a snapshot or array.
 * @param {Array} items — array of extracted items
 * @param {string} itemType — type of items
 * @returns {Array} — items with importance scores added
 */
export function addImportanceScores(items, itemType = 'generic') {
  try {
    if (!Array.isArray(items)) {
      return [];
    }

    return items.map((item) => ({
      ...item,
      importance: calculateImportance(item, items, itemType),
    }));
  } catch (err) {
    console.warn(`Error adding importance scores: ${err.message}`);
    return items;
  }
}

/**
 * Sort items by importance score (highest first).
 * @param {Array} items — items with importance scores
 * @returns {Array} — sorted items
 */
export function sortByImportance(items) {
  try {
    if (!Array.isArray(items)) {
      return [];
    }

    return [...items].sort((a, b) => {
      const scoreA = a.importance ?? 0;
      const scoreB = b.importance ?? 0;
      return scoreB - scoreA;
    });
  } catch (err) {
    console.warn(`Error sorting by importance: ${err.message}`);
    return items;
  }
}

/**
 * Create a full context snapshot as JSON.
 * @param {Array<{role:string, content:string}>} messages
 * @returns {{id:string, ts:string, decisions:Array, codeChanges:Array, patterns:Array, tasks:Array, messageCount:number}}
 */
export function createSnapshot(messages) {
  try {
    if (!Array.isArray(messages)) {
      messages = [];
    }

    return {
      id: `snap-${hashContent(timestamp() + messages.length)}`,
      ts: timestamp(),
      decisions: extractDecisions(messages),
      codeChanges: extractCodeChanges(messages),
      patterns: extractPatterns(messages),
      tasks: extractTasks(messages),
      messageCount: messages.length,
    };
  } catch (err) {
    console.warn(`Error creating snapshot: ${err.message}`);
    return {
      id: `snap-error-${Date.now()}`,
      ts: timestamp(),
      decisions: [],
      codeChanges: [],
      patterns: [],
      tasks: [],
      messageCount: 0,
    };
  }
}

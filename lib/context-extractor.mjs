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
  const decisions = [];
  for (const msg of messages) {
    const lines = (msg.content ?? '').split('\n');
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
}

/**
 * List all files modified with summaries.
 * @param {Array<{role:string, content:string}>} messages
 * @returns {Array<{id:string, file:string, action:string, summary:string, ts:string}>}
 */
export function extractCodeChanges(messages) {
  const changes = [];
  const fileRe = /\b([\w/.@-]+\.\w{1,6})(?::(\d+))?\b/g;

  for (const msg of messages) {
    const text = msg.content ?? '';
    if (!matchesAny(text, CODE_CHANGE_SIGNALS)) continue;

    const lines = text.split('\n');
    for (const line of lines) {
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
}

/**
 * Extract behavioral patterns learned during the conversation.
 * @param {Array<{role:string, content:string}>} messages
 * @returns {Array<{id:string, pattern:string, source:string, ts:string}>}
 */
export function extractPatterns(messages) {
  const patterns = [];
  for (const msg of messages) {
    const lines = (msg.content ?? '').split('\n');
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
}

/**
 * Extract pending and completed tasks.
 * @param {Array<{role:string, content:string}>} messages
 * @returns {Array<{id:string, task:string, status:string, ts:string}>}
 */
export function extractTasks(messages) {
  const tasks = [];
  for (const msg of messages) {
    const lines = (msg.content ?? '').split('\n');
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
}

/**
 * Create a full context snapshot as JSON.
 * @param {Array<{role:string, content:string}>} messages
 * @returns {{id:string, ts:string, decisions:Array, codeChanges:Array, patterns:Array, tasks:Array, messageCount:number}}
 */
export function createSnapshot(messages) {
  return {
    id: `snap-${hashContent(timestamp() + messages.length)}`,
    ts: timestamp(),
    decisions: extractDecisions(messages),
    codeChanges: extractCodeChanges(messages),
    patterns: extractPatterns(messages),
    tasks: extractTasks(messages),
    messageCount: messages.length,
  };
}

/**
 * session-bridge.mjs — Bridge context across sessions
 *
 * Persists session summaries to ~/.nexus/sessions/ and provides
 * lookup, search, and merge capabilities so knowledge survives
 * across completely separate Claude Code sessions.
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const SESSIONS_DIR = join(homedir(), '.nexus', 'sessions');

function ensureDir() {
  if (!existsSync(SESSIONS_DIR)) {
    mkdirSync(SESSIONS_DIR, { recursive: true });
  }
}

function sessionPath(sessionId) {
  // Sanitise to prevent path traversal
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(SESSIONS_DIR, `${safe}.json`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Save a session summary to disk.
 * @param {string} sessionId — unique session identifier
 * @param {object} summary   — session summary data
 * @returns {{saved:string, path:string}}
 */
export function saveSessionSummary(sessionId, summary) {
  try {
    if (!sessionId || typeof sessionId !== 'string') {
      throw new Error('sessionId must be a non-empty string');
    }

    ensureDir();
    const path = sessionPath(sessionId);
    const record = {
      sessionId,
      summary,
      savedAt: new Date().toISOString(),
    };
    writeFileSync(path, JSON.stringify(record, null, 2), 'utf-8');
    return { saved: record.savedAt, path };
  } catch (err) {
    throw new Error(`Failed to save session summary: ${err.message}`);
  }
}

/**
 * Load a previously saved session summary.
 * @param {string} sessionId
 * @returns {object|null} — the session record or null if not found
 */
export function loadSessionSummary(sessionId) {
  try {
    if (!sessionId || typeof sessionId !== 'string') {
      return null;
    }

    ensureDir();
    const path = sessionPath(sessionId);
    if (!existsSync(path)) return null;

    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    console.warn(`Failed to load session summary: ${err.message}`);
    return null;
  }
}

/**
 * Search past sessions by content (substring or RegExp).
 * @param {string|RegExp} queryPattern
 * @returns {Array<object>} matching session records
 */
export function findRelevantSessions(queryPattern) {
  try {
    ensureDir();

    if (!queryPattern) {
      return [];
    }

    const re =
      queryPattern instanceof RegExp ? queryPattern : new RegExp(queryPattern, 'i');

    const results = [];
    const files = readdirSync(SESSIONS_DIR);

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = readFileSync(join(SESSIONS_DIR, file), 'utf-8');
        if (re.test(raw)) {
          results.push(JSON.parse(raw));
        }
      } catch {
        // skip corrupt files
      }
    }

    // Most recent first
    results.sort(
      (a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime(),
    );
    return results;
  } catch (err) {
    console.warn(`Failed to find relevant sessions: ${err.message}`);
    return [];
  }
}

/**
 * Calculate similarity score between two sessions based on content overlap.
 * @param {object} session1 — first session record
 * @param {object} session2 — second session record
 * @returns {number} — similarity score (0-1)
 */
export function calculateSessionSimilarity(session1, session2) {
  try {
    if (!session1 || !session2 || typeof session1 !== 'object' || typeof session2 !== 'object') {
      return 0;
    }

    const summary1 = session1.summary ?? session1;
    const summary2 = session2.summary ?? session2;

    // Extract all unique IDs and text from both sessions
    function extractTokens(summary) {
      const tokens = new Set();
      const fields = ['decisions', 'codeChanges', 'patterns', 'tasks'];

      for (const field of fields) {
        const items = summary[field] ?? [];
        if (!Array.isArray(items)) continue;

        for (const item of items) {
          if (!item || typeof item !== 'object') continue;

          // Add ID
          if (item.id) tokens.add(item.id);

          // Add text tokens (normalized)
          const text = item.text ?? item.pattern ?? item.task ?? item.file ?? item.summary ?? '';
          if (typeof text === 'string') {
            const words = text
              .toLowerCase()
              .split(/[^a-z0-9]+/)
              .filter((w) => w.length > 3);
            words.forEach((w) => tokens.add(w));
          }
        }
      }

      return tokens;
    }

    const tokens1 = extractTokens(summary1);
    const tokens2 = extractTokens(summary2);

    if (tokens1.size === 0 || tokens2.size === 0) {
      return 0;
    }

    // Jaccard similarity
    const intersection = [...tokens1].filter((t) => tokens2.has(t));
    const union = new Set([...tokens1, ...tokens2]);

    return intersection.length / union.size;
  } catch (err) {
    console.warn(`Error calculating session similarity: ${err.message}`);
    return 0;
  }
}

/**
 * Find similar sessions to a given session.
 * @param {object} targetSession — session to compare against
 * @param {Array<object>} candidateSessions — array of session records to compare
 * @param {number} [minSimilarity=0.1] — minimum similarity threshold (0-1)
 * @param {number} [topN=5] — maximum number of similar sessions to return
 * @returns {Array<{session:object, similarity:number}>} — similar sessions with scores
 */
export function findSimilarSessions(targetSession, candidateSessions, minSimilarity = 0.1, topN = 5) {
  try {
    if (!targetSession || typeof targetSession !== 'object') {
      return [];
    }

    if (!Array.isArray(candidateSessions)) {
      return [];
    }

    const similarities = candidateSessions
      .filter((s) => s && typeof s === 'object')
      .map((session) => ({
        session,
        similarity: calculateSessionSimilarity(targetSession, session),
      }))
      .filter((item) => item.similarity >= minSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topN);

    return similarities;
  } catch (err) {
    console.warn(`Error finding similar sessions: ${err.message}`);
    return [];
  }
}

/**
 * Compare two sessions and return detailed overlap metrics.
 * @param {object} session1 — first session
 * @param {object} session2 — second session
 * @returns {{similarity:number, sharedDecisions:number, sharedFiles:number, sharedPatterns:number, sharedTasks:number}}
 */
export function compareSessionDetails(session1, session2) {
  try {
    if (!session1 || !session2 || typeof session1 !== 'object' || typeof session2 !== 'object') {
      return { similarity: 0, sharedDecisions: 0, sharedFiles: 0, sharedPatterns: 0, sharedTasks: 0 };
    }

    const summary1 = session1.summary ?? session1;
    const summary2 = session2.summary ?? session2;

    function getIds(items) {
      if (!Array.isArray(items)) return new Set();
      return new Set(items.filter((i) => i && i.id).map((i) => i.id));
    }

    function getFiles(items) {
      if (!Array.isArray(items)) return new Set();
      return new Set(items.filter((i) => i && i.file).map((i) => i.file));
    }

    const decisions1 = getIds(summary1.decisions ?? []);
    const decisions2 = getIds(summary2.decisions ?? []);
    const sharedDecisions = [...decisions1].filter((id) => decisions2.has(id)).length;

    const files1 = getFiles(summary1.codeChanges ?? []);
    const files2 = getFiles(summary2.codeChanges ?? []);
    const sharedFiles = [...files1].filter((f) => files2.has(f)).length;

    const patterns1 = getIds(summary1.patterns ?? []);
    const patterns2 = getIds(summary2.patterns ?? []);
    const sharedPatterns = [...patterns1].filter((id) => patterns2.has(id)).length;

    const tasks1 = getIds(summary1.tasks ?? []);
    const tasks2 = getIds(summary2.tasks ?? []);
    const sharedTasks = [...tasks1].filter((id) => tasks2.has(id)).length;

    const similarity = calculateSessionSimilarity(session1, session2);

    return {
      similarity,
      sharedDecisions,
      sharedFiles,
      sharedPatterns,
      sharedTasks,
    };
  } catch (err) {
    console.warn(`Error comparing session details: ${err.message}`);
    return { similarity: 0, sharedDecisions: 0, sharedFiles: 0, sharedPatterns: 0, sharedTasks: 0 };
  }
}

/**
 * Merge multiple session contexts into a single unified context object.
 * @param {Array<object>} sessions — array of session records
 * @returns {{decisions:Array, codeChanges:Array, patterns:Array, tasks:Array, sessionCount:number}}
 */
export function mergeContexts(sessions) {
  try {
    if (!Array.isArray(sessions)) {
      sessions = [];
    }

    const merged = {
      decisions: [],
      codeChanges: [],
      patterns: [],
      tasks: [],
      sessionCount: sessions.length,
    };

    const seen = new Set();

    for (const session of sessions) {
      if (!session || typeof session !== 'object') continue;

      const summary = session.summary ?? session;
      for (const field of ['decisions', 'codeChanges', 'patterns', 'tasks']) {
        const items = summary[field] ?? [];
        if (!Array.isArray(items)) continue;

        for (const item of items) {
          if (!item || typeof item !== 'object') continue;

          const key = item.id ?? JSON.stringify(item);
          if (!seen.has(key)) {
            seen.add(key);
            merged[field].push(item);
          }
        }
      }
    }

    return merged;
  } catch (err) {
    console.warn(`Failed to merge contexts: ${err.message}`);
    return {
      decisions: [],
      codeChanges: [],
      patterns: [],
      tasks: [],
      sessionCount: 0,
    };
  }
}

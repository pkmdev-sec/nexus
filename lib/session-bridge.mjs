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

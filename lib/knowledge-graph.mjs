/**
 * knowledge-graph.mjs — Persistent knowledge storage
 *
 * Stores knowledge nodes with metadata and relationships in a JSON
 * file at ~/.nexus/knowledge.json.  Each node has a key, value,
 * metadata (timestamps, tags, relations), and optional edges to
 * other nodes.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// Storage path
// ---------------------------------------------------------------------------

const NEXUS_DIR = join(homedir(), '.nexus');
const DB_PATH = join(NEXUS_DIR, 'knowledge.json');
const LOCK_PATH = join(NEXUS_DIR, 'knowledge.json.lock');

// Input validation limits
const MAX_KEY_LENGTH = 1000;
const MAX_VALUE_SIZE = 10 * 1024 * 1024; // 10MB

function ensureDir() {
  if (!existsSync(NEXUS_DIR)) {
    mkdirSync(NEXUS_DIR, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// File locking for concurrent access
// ---------------------------------------------------------------------------

function acquireLock(timeoutMs = 5000) {
  const start = Date.now();
  while (existsSync(LOCK_PATH)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Failed to acquire lock: timeout');
    }
    // Wait a bit before retrying
    const wait = Date.now() + 50;
    while (Date.now() < wait) {}
  }
  try {
    writeFileSync(LOCK_PATH, String(process.pid), 'utf-8');
  } catch (err) {
    throw new Error(`Failed to acquire lock: ${err.message}`);
  }
}

function releaseLock() {
  try {
    if (existsSync(LOCK_PATH)) {
      unlinkSync(LOCK_PATH);
    }
  } catch {
    // Best effort
  }
}

// ---------------------------------------------------------------------------
// Internal graph state
// ---------------------------------------------------------------------------

let _graph = null; // lazy-loaded
let _lastModTime = null; // track file modification time

function loadGraph() {
  ensureDir();

  try {
    if (existsSync(DB_PATH)) {
      const stats = statSync(DB_PATH);
      const currentModTime = stats.mtimeMs;

      // Check if file was modified since we last loaded it
      if (_graph && _lastModTime !== null && _lastModTime === currentModTime) {
        return _graph;
      }

      // File changed or first load - read from disk
      try {
        _graph = JSON.parse(readFileSync(DB_PATH, 'utf-8'));
        _lastModTime = currentModTime;
      } catch (err) {
        console.warn(`Failed to parse knowledge.json: ${err.message}`);
        _graph = { nodes: {}, meta: { created: new Date().toISOString(), version: 1 } };
        _lastModTime = null;
      }
    } else {
      _graph = { nodes: {}, meta: { created: new Date().toISOString(), version: 1 } };
      _lastModTime = null;
    }
  } catch (err) {
    console.warn(`Error loading graph: ${err.message}`);
    if (!_graph) {
      _graph = { nodes: {}, meta: { created: new Date().toISOString(), version: 1 } };
    }
  }

  return _graph;
}

function persist() {
  ensureDir();

  try {
    // Acquire lock for concurrent access safety
    acquireLock();

    try {
      // Re-read from disk to check for external changes
      let diskGraph = null;
      if (existsSync(DB_PATH)) {
        try {
          diskGraph = JSON.parse(readFileSync(DB_PATH, 'utf-8'));
        } catch (err) {
          console.warn(`Failed to read existing knowledge.json during persist: ${err.message}`);
        }
      }

      // If disk has changes we didn't know about, merge them
      if (diskGraph && diskGraph.nodes) {
        for (const [key, node] of Object.entries(diskGraph.nodes)) {
          // Keep disk version if we don't have this node or disk version is newer
          if (!_graph.nodes[key]) {
            _graph.nodes[key] = node;
          } else {
            const ourTime = new Date(_graph.nodes[key].metadata?.updatedAt ?? 0).getTime();
            const diskTime = new Date(node.metadata?.updatedAt ?? 0).getTime();
            if (diskTime > ourTime) {
              _graph.nodes[key] = node;
            }
          }
        }
      }

      // Write merged graph
      writeFileSync(DB_PATH, JSON.stringify(_graph, null, 2), 'utf-8');

      // Update mod time tracking
      const stats = statSync(DB_PATH);
      _lastModTime = stats.mtimeMs;
    } finally {
      releaseLock();
    }
  } catch (err) {
    throw new Error(`Failed to persist knowledge graph: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Store a knowledge node.
 * @param {string} key   — unique identifier
 * @param {*}      value — any serialisable data
 * @param {object} [metadata] — optional { tags, relations, ttl, ... }
 * @returns {{key:string, stored:string}}
 */
export function store(key, value, metadata = {}) {
  try {
    // Input validation
    if (!key || typeof key !== 'string') {
      throw new Error('Key must be a non-empty string');
    }
    if (key.length > MAX_KEY_LENGTH) {
      throw new Error(`Key exceeds maximum length of ${MAX_KEY_LENGTH}`);
    }

    const valueStr = JSON.stringify(value);
    if (valueStr.length > MAX_VALUE_SIZE) {
      throw new Error(`Value exceeds maximum size of ${MAX_VALUE_SIZE} bytes`);
    }

    const graph = loadGraph();
    const now = new Date().toISOString();
    graph.nodes[key] = {
      key,
      value,
      metadata: {
        ...metadata,
        createdAt: graph.nodes[key]?.metadata?.createdAt ?? now,
        updatedAt: now,
      },
    };
    persist();
    return { key, stored: now };
  } catch (err) {
    throw new Error(`Failed to store knowledge node '${key}': ${err.message}`);
  }
}

/**
 * Find knowledge nodes whose keys or tags match a pattern.
 * @param {string|RegExp} pattern — string (substring) or RegExp
 * @returns {Array<{key:string, value:*, metadata:object}>}
 */
export function query(pattern) {
  try {
    const graph = loadGraph();
    const re = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i');
    return Object.values(graph.nodes).filter((node) => {
      if (re.test(node.key)) return true;
      const tags = node.metadata?.tags ?? [];
      return tags.some((t) => re.test(t));
    });
  } catch (err) {
    throw new Error(`Failed to query knowledge graph: ${err.message}`);
  }
}

/**
 * Find nodes connected to `key` via the `relations` metadata field.
 * @param {string} key
 * @returns {Array<{key:string, value:*, metadata:object}>}
 */
export function getRelated(key) {
  try {
    const graph = loadGraph();
    const node = graph.nodes[key];
    if (!node) return [];

    const relations = node.metadata?.relations ?? [];
    return relations
      .map((r) => graph.nodes[r])
      .filter(Boolean);
  } catch (err) {
    throw new Error(`Failed to get related nodes for '${key}': ${err.message}`);
  }
}

/**
 * Remove nodes older than maxAge milliseconds that are not pinned.
 * @param {number} maxAge — age in milliseconds
 * @returns {number} count of pruned nodes
 */
export function prune(maxAge) {
  try {
    if (typeof maxAge !== 'number' || maxAge < 0) {
      throw new Error('maxAge must be a non-negative number');
    }

    const graph = loadGraph();
    const cutoff = Date.now() - maxAge;
    let pruned = 0;

    for (const [key, node] of Object.entries(graph.nodes)) {
      if (node.metadata?.pinned) continue;
      const updated = new Date(node.metadata?.updatedAt ?? 0).getTime();
      if (updated < cutoff) {
        delete graph.nodes[key];
        pruned++;
      }
    }

    if (pruned > 0) persist();
    return pruned;
  } catch (err) {
    throw new Error(`Failed to prune knowledge graph: ${err.message}`);
  }
}

/**
 * Export the entire graph as a JSON-serialisable object.
 * @returns {object}
 */
export function exportGraph() {
  try {
    return structuredClone(loadGraph());
  } catch (err) {
    throw new Error(`Failed to export knowledge graph: ${err.message}`);
  }
}

/**
 * Import a previously exported graph, merging with existing data.
 * @param {object} data — graph object from exportGraph()
 * @returns {{imported:number}}
 */
export function importGraph(data) {
  try {
    if (!data || typeof data !== 'object') {
      throw new Error('Import data must be an object');
    }

    const graph = loadGraph();
    let imported = 0;
    if (data?.nodes) {
      for (const [key, node] of Object.entries(data.nodes)) {
        if (!graph.nodes[key]) {
          graph.nodes[key] = node;
          imported++;
        }
      }
    }
    persist();
    return { imported };
  } catch (err) {
    throw new Error(`Failed to import knowledge graph: ${err.message}`);
  }
}

/**
 * Reset the in-memory cache so the next operation re-reads from disk.
 * Useful for testing.
 */
export function _resetCache() {
  _graph = null;
}

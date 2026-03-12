/**
 * knowledge-graph.mjs — Persistent knowledge storage
 *
 * Stores knowledge nodes with metadata and relationships in a JSON
 * file at ~/.nexus/knowledge.json.  Each node has a key, value,
 * metadata (timestamps, tags, relations), and optional edges to
 * other nodes.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// Storage path
// ---------------------------------------------------------------------------

const NEXUS_DIR = join(homedir(), '.nexus');
const DB_PATH = join(NEXUS_DIR, 'knowledge.json');

function ensureDir() {
  if (!existsSync(NEXUS_DIR)) {
    mkdirSync(NEXUS_DIR, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Internal graph state
// ---------------------------------------------------------------------------

let _graph = null; // lazy-loaded

function loadGraph() {
  if (_graph) return _graph;
  ensureDir();
  if (existsSync(DB_PATH)) {
    try {
      _graph = JSON.parse(readFileSync(DB_PATH, 'utf-8'));
    } catch {
      _graph = { nodes: {}, meta: { created: new Date().toISOString(), version: 1 } };
    }
  } else {
    _graph = { nodes: {}, meta: { created: new Date().toISOString(), version: 1 } };
  }
  return _graph;
}

function persist() {
  ensureDir();
  writeFileSync(DB_PATH, JSON.stringify(_graph, null, 2), 'utf-8');
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
}

/**
 * Find knowledge nodes whose keys or tags match a pattern.
 * @param {string|RegExp} pattern — string (substring) or RegExp
 * @returns {Array<{key:string, value:*, metadata:object}>}
 */
export function query(pattern) {
  const graph = loadGraph();
  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i');
  return Object.values(graph.nodes).filter((node) => {
    if (re.test(node.key)) return true;
    const tags = node.metadata?.tags ?? [];
    return tags.some((t) => re.test(t));
  });
}

/**
 * Find nodes connected to `key` via the `relations` metadata field.
 * @param {string} key
 * @returns {Array<{key:string, value:*, metadata:object}>}
 */
export function getRelated(key) {
  const graph = loadGraph();
  const node = graph.nodes[key];
  if (!node) return [];

  const relations = node.metadata?.relations ?? [];
  return relations
    .map((r) => graph.nodes[r])
    .filter(Boolean);
}

/**
 * Remove nodes older than maxAge milliseconds that are not pinned.
 * @param {number} maxAge — age in milliseconds
 * @returns {number} count of pruned nodes
 */
export function prune(maxAge) {
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
}

/**
 * Export the entire graph as a JSON-serialisable object.
 * @returns {object}
 */
export function exportGraph() {
  return structuredClone(loadGraph());
}

/**
 * Import a previously exported graph, merging with existing data.
 * @param {object} data — graph object from exportGraph()
 * @returns {{imported:number}}
 */
export function importGraph(data) {
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
}

/**
 * Reset the in-memory cache so the next operation re-reads from disk.
 * Useful for testing.
 */
export function _resetCache() {
  _graph = null;
}

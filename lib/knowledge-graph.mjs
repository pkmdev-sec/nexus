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
 * Find a path between two concepts using Breadth-First Search.
 * @param {string} startKey — starting node key
 * @param {string} endKey — target node key
 * @returns {Array<string>|null} — array of keys representing the path, or null if no path exists
 */
export function findPathBFS(startKey, endKey) {
  try {
    if (!startKey || !endKey || typeof startKey !== 'string' || typeof endKey !== 'string') {
      return null;
    }

    const graph = loadGraph();
    if (!graph.nodes[startKey] || !graph.nodes[endKey]) {
      return null;
    }

    if (startKey === endKey) {
      return [startKey];
    }

    const queue = [[startKey]];
    const visited = new Set([startKey]);

    while (queue.length > 0) {
      const path = queue.shift();
      const current = path[path.length - 1];
      const node = graph.nodes[current];

      const relations = node.metadata?.relations ?? [];
      for (const neighbor of relations) {
        if (!graph.nodes[neighbor]) continue;
        if (visited.has(neighbor)) continue;

        const newPath = [...path, neighbor];
        if (neighbor === endKey) {
          return newPath;
        }

        visited.add(neighbor);
        queue.push(newPath);
      }
    }

    return null;
  } catch (err) {
    console.warn(`Error finding BFS path: ${err.message}`);
    return null;
  }
}

/**
 * Find a path between two concepts using Depth-First Search.
 * @param {string} startKey — starting node key
 * @param {string} endKey — target node key
 * @param {number} [maxDepth=50] — maximum search depth to prevent infinite loops
 * @returns {Array<string>|null} — array of keys representing the path, or null if no path exists
 */
export function findPathDFS(startKey, endKey, maxDepth = 50) {
  try {
    if (!startKey || !endKey || typeof startKey !== 'string' || typeof endKey !== 'string') {
      return null;
    }

    const graph = loadGraph();
    if (!graph.nodes[startKey] || !graph.nodes[endKey]) {
      return null;
    }

    if (startKey === endKey) {
      return [startKey];
    }

    const visited = new Set();

    function dfs(current, path, depth) {
      if (depth > maxDepth) return null;
      if (current === endKey) return path;

      visited.add(current);
      const node = graph.nodes[current];
      const relations = node.metadata?.relations ?? [];

      for (const neighbor of relations) {
        if (!graph.nodes[neighbor]) continue;
        if (visited.has(neighbor)) continue;

        const result = dfs(neighbor, [...path, neighbor], depth + 1);
        if (result) return result;
      }

      return null;
    }

    return dfs(startKey, [startKey], 0);
  } catch (err) {
    console.warn(`Error finding DFS path: ${err.message}`);
    return null;
  }
}

/**
 * Find all paths between two concepts (up to a maximum number).
 * @param {string} startKey — starting node key
 * @param {string} endKey — target node key
 * @param {number} [maxPaths=10] — maximum number of paths to find
 * @param {number} [maxDepth=50] — maximum path length
 * @returns {Array<Array<string>>} — array of paths, each path is an array of keys
 */
export function findAllPaths(startKey, endKey, maxPaths = 10, maxDepth = 50) {
  try {
    if (!startKey || !endKey || typeof startKey !== 'string' || typeof endKey !== 'string') {
      return [];
    }

    const graph = loadGraph();
    if (!graph.nodes[startKey] || !graph.nodes[endKey]) {
      return [];
    }

    if (startKey === endKey) {
      return [[startKey]];
    }

    const allPaths = [];

    function dfs(current, path, visited, depth) {
      if (allPaths.length >= maxPaths || depth > maxDepth) return;
      if (current === endKey) {
        allPaths.push([...path]);
        return;
      }

      const node = graph.nodes[current];
      const relations = node.metadata?.relations ?? [];

      for (const neighbor of relations) {
        if (!graph.nodes[neighbor]) continue;
        if (visited.has(neighbor)) continue;

        visited.add(neighbor);
        dfs(neighbor, [...path, neighbor], visited, depth + 1);
        visited.delete(neighbor);
      }
    }

    const visited = new Set([startKey]);
    dfs(startKey, [startKey], visited, 0);

    return allPaths;
  } catch (err) {
    console.warn(`Error finding all paths: ${err.message}`);
    return [];
  }
}

/**
 * Get the shortest path distance between two concepts.
 * @param {string} startKey — starting node key
 * @param {string} endKey — target node key
 * @returns {number|null} — distance (number of edges), or null if no path exists
 */
export function getPathDistance(startKey, endKey) {
  try {
    const path = findPathBFS(startKey, endKey);
    if (!path) return null;
    return path.length - 1; // Number of edges is nodes - 1
  } catch (err) {
    console.warn(`Error getting path distance: ${err.message}`);
    return null;
  }
}

/**
 * Reset the in-memory cache so the next operation re-reads from disk.
 * Useful for testing.
 */
export function _resetCache() {
  _graph = null;
}

/**
 * Export the knowledge graph in DOT format for Graphviz visualization
 * @param {Object} options - Export options
 * @param {boolean} [options.includeMetadata=true] - Include node metadata as labels
 * @param {string} [options.layout='dot'] - Graphviz layout engine hint
 * @param {boolean} [options.colorByAge=true] - Color nodes by recency
 * @returns {string} DOT format string
 */
export function exportDOT(options = {}) {
  const { includeMetadata = true, layout = 'dot', colorByAge = true } = options;
  const graph = exportGraph();
  const nodes = graph.nodes || graph;
  const lines = [`digraph NexusKnowledge {`, `  layout=${layout};`, `  rankdir=LR;`, `  node [shape=box, style=filled, fontname="Helvetica"];`, ``];

  const now = Date.now();
  const DAY = 86400000;

  for (const [key, node] of Object.entries(nodes)) {
    const safeKey = key.replace(/[^a-zA-Z0-9_]/g, '_');
    const label = key.replace(/"/g, '\\"');
    const value = (typeof node.value === 'string' ? node.value : JSON.stringify(node.value || '')).substring(0, 60).replace(/"/g, '\\"');

    let color = '#E8E8E8';
    if (colorByAge && node.metadata?.updatedAt) {
      const age = (now - new Date(node.metadata.updatedAt).getTime()) / DAY;
      if (age < 1) color = '#90EE90';
      else if (age < 7) color = '#87CEEB';
      else if (age < 30) color = '#FFD700';
      else color = '#FFA07A';
    }

    const tooltip = includeMetadata ? `\\n${value}` : '';
    lines.push(`  ${safeKey} [label="${label}${tooltip}", fillcolor="${color}"];`);

    // Add edges for relations
    const relations = node.metadata?.relations || [];
    for (const rel of relations) {
      const safeRel = rel.replace(/[^a-zA-Z0-9_]/g, '_');
      lines.push(`  ${safeKey} -> ${safeRel};`);
    }
  }

  lines.push(`}`);
  return lines.join('\n');
}

/**
 * Export the knowledge graph as a Mermaid diagram
 * @returns {string} Mermaid diagram syntax
 */
export function exportMermaid() {
  const graph = exportGraph();
  const nodes = graph.nodes || graph;
  const lines = ['graph LR'];

  for (const [key, node] of Object.entries(nodes)) {
    const safeKey = key.replace(/[^a-zA-Z0-9_]/g, '_');
    const label = key.replace(/"/g, '#quot;');
    lines.push(`  ${safeKey}["${label}"]`);

    const relations = node.metadata?.relations || [];
    for (const rel of relations) {
      const safeRel = rel.replace(/[^a-zA-Z0-9_]/g, '_');
      lines.push(`  ${safeKey} --> ${safeRel}`);
    }
  }

  return lines.join('\n');
}

/**
 * Get graph statistics for maintenance decisions
 * @returns {Object} Statistics about the knowledge graph
 */
export function getGraphStats() {
  const graph = exportGraph();
  const nodes = graph.nodes || graph;
  const entries = Object.entries(nodes);
  const now = Date.now();
  const DAY = 86400000;

  let totalNodes = entries.length;
  let pinnedCount = 0;
  let orphanCount = 0;
  let staleCount = 0;  // older than 30 days
  let tagCounts = {};

  for (const [key, node] of entries) {
    const meta = node.metadata || {};
    if (meta.pinned) pinnedCount++;
    if ((!meta.relations || meta.relations.length === 0)) orphanCount++;
    if (meta.updatedAt && (now - new Date(meta.updatedAt).getTime()) > 30 * DAY) staleCount++;
    for (const tag of (meta.tags || [])) {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }
  }

  return { totalNodes, pinnedCount, orphanCount, staleCount, tagCounts };
}

/**
 * Remove orphan nodes (no relations to other nodes)
 * @param {Object} options - Cleanup options
 * @param {boolean} [options.keepPinned=true] - Keep pinned orphans
 * @param {number} [options.minAge=0] - Only remove orphans older than this (ms)
 * @returns {Object} Cleanup results
 */
export function pruneOrphans(options = {}) {
  // Read, filter, write back
  const { keepPinned = true, minAge = 0 } = options;
  const graph = exportGraph();
  const nodes = graph.nodes || graph;
  const now = Date.now();
  let removed = 0;

  for (const [key, node] of Object.entries(nodes)) {
    const meta = node.metadata || {};
    const hasRelations = meta.relations && meta.relations.length > 0;
    const isPinned = meta.pinned;
    const age = meta.updatedAt ? now - new Date(meta.updatedAt).getTime() : Infinity;

    if (!hasRelations && !(keepPinned && isPinned) && age >= minAge) {
      delete nodes[key];
      removed++;
    }
  }

  if (removed > 0) {
    importGraph(typeof graph.nodes !== 'undefined' ? graph : { nodes });
  }

  return { removed, remaining: Object.keys(nodes).length };
}

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  store,
  query,
  getRelated,
  prune,
  exportGraph,
  importGraph,
  findPathBFS,
  findPathDFS,
  findAllPaths,
  getPathDistance,
  _resetCache,
} from '../lib/knowledge-graph.mjs';

const HOME = process.env.HOME;
const NEXUS_DIR = join(HOME, '.nexus');
const KNOWLEDGE_PATH = join(NEXUS_DIR, 'knowledge.json');
const BACKUP_PATH = join(tmpdir(), `nexus-backup-${Date.now()}.json`);

let hadExisting = false;

describe('knowledge-graph', () => {
  beforeEach(() => {
    _resetCache();
    if (existsSync(KNOWLEDGE_PATH)) {
      hadExisting = true;
      writeFileSync(BACKUP_PATH, readFileSync(KNOWLEDGE_PATH));
    }
    if (existsSync(KNOWLEDGE_PATH)) {
      rmSync(KNOWLEDGE_PATH);
    }
    _resetCache();
  });

  afterEach(() => {
    _resetCache();
    if (hadExisting && existsSync(BACKUP_PATH)) {
      mkdirSync(NEXUS_DIR, { recursive: true });
      writeFileSync(KNOWLEDGE_PATH, readFileSync(BACKUP_PATH));
    }
  });

  it('should store and retrieve a node', () => {
    store('test-key', 'test-value', { tags: ['test'] });
    const results = query('test-key');
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].value, 'test-value');
  });

  it('should store objects as values', () => {
    store('obj-key', { foo: 'bar', num: 42 });
    const results = query('obj-key');
    assert.deepStrictEqual(results[0].value, { foo: 'bar', num: 42 });
  });

  it('should query by tag', () => {
    store('tagged-1', 'val1', { tags: ['alpha'] });
    store('tagged-2', 'val2', { tags: ['beta'] });
    const results = query('alpha');
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].key, 'tagged-1');
  });

  it('should query with regex', () => {
    store('prefix-abc', 'v1');
    store('prefix-xyz', 'v2');
    store('other', 'v3');
    const results = query(/^prefix-/);
    assert.strictEqual(results.length, 2);
  });

  it('should return empty for non-matching query', () => {
    store('foo', 'bar');
    const results = query('zzz-no-match');
    assert.strictEqual(results.length, 0);
  });

  it('should find related nodes', () => {
    store('node-a', 'A', { relations: ['node-b', 'node-c'] });
    store('node-b', 'B');
    store('node-c', 'C');
    const related = getRelated('node-a');
    assert.strictEqual(related.length, 2);
    assert.ok(related.some((r) => r.key === 'node-b'));
    assert.ok(related.some((r) => r.key === 'node-c'));
  });

  it('should return empty for non-existent key', () => {
    assert.deepStrictEqual(getRelated('ghost'), []);
  });

  it('should handle missing relation targets', () => {
    store('node-x', 'X', { relations: ['nonexistent'] });
    const related = getRelated('node-x');
    assert.strictEqual(related.length, 0);
  });

  it('should prune old entries', () => {
    store('old-entry', 'ancient');
    _resetCache();

    const graph = JSON.parse(readFileSync(KNOWLEDGE_PATH, 'utf-8'));
    graph.nodes['old-entry'].metadata.updatedAt = '2020-01-01T00:00:00.000Z';
    writeFileSync(KNOWLEDGE_PATH, JSON.stringify(graph));
    _resetCache();

    const pruned = prune(1000);
    assert.ok(pruned >= 1, 'Should prune at least one entry');
  });

  it('should not prune pinned entries', () => {
    store('pinned-entry', 'important', { pinned: true });
    _resetCache();

    const graph = JSON.parse(readFileSync(KNOWLEDGE_PATH, 'utf-8'));
    graph.nodes['pinned-entry'].metadata.updatedAt = '2020-01-01T00:00:00.000Z';
    writeFileSync(KNOWLEDGE_PATH, JSON.stringify(graph));
    _resetCache();

    prune(1000);
    const results = query('pinned-entry');
    assert.strictEqual(results.length, 1, 'Pinned entry should survive pruning');
  });

  it('should export and import graph data', () => {
    store('exp-1', 'val1');
    store('exp-2', 'val2');
    const exported = exportGraph();
    assert.ok(exported.nodes['exp-1']);
    assert.ok(exported.nodes['exp-2']);

    rmSync(KNOWLEDGE_PATH);
    _resetCache();

    const { imported } = importGraph(exported);
    assert.strictEqual(imported, 2);

    const results = query('exp-');
    assert.strictEqual(results.length, 2);
  });

  it('should not duplicate on import', () => {
    store('dup-key', 'original');
    const exported = exportGraph();

    const { imported } = importGraph(exported);
    assert.strictEqual(imported, 0, 'Should not re-import existing keys');
  });

  // -- Graph Traversal Tests (P1 Features) --

  describe('findPathBFS', () => {
    it('should find shortest path between connected nodes', () => {
      store('a', 'Node A', { relations: ['b', 'c'] });
      store('b', 'Node B', { relations: ['d'] });
      store('c', 'Node C', { relations: ['d'] });
      store('d', 'Node D');

      const path = findPathBFS('a', 'd');
      assert.ok(path, 'Should find a path');
      assert.strictEqual(path[0], 'a');
      assert.strictEqual(path[path.length - 1], 'd');
      assert.strictEqual(path.length, 3, 'Shortest path should be a->b->d or a->c->d');
    });

    it('should return null for non-existent nodes', () => {
      assert.strictEqual(findPathBFS('ghost1', 'ghost2'), null);
      assert.strictEqual(findPathBFS('', 'a'), null);
      assert.strictEqual(findPathBFS(null, 'a'), null);
    });

    it('should return single-node path for same start and end', () => {
      store('same', 'Same node');
      const path = findPathBFS('same', 'same');
      assert.deepStrictEqual(path, ['same']);
    });

    it('should return null when no path exists', () => {
      store('isolated-a', 'A');
      store('isolated-b', 'B');
      const path = findPathBFS('isolated-a', 'isolated-b');
      assert.strictEqual(path, null);
    });

    it('should handle circular references', () => {
      store('cycle-a', 'A', { relations: ['cycle-b'] });
      store('cycle-b', 'B', { relations: ['cycle-c'] });
      store('cycle-c', 'C', { relations: ['cycle-a'] });

      const path = findPathBFS('cycle-a', 'cycle-c');
      assert.ok(path);
      assert.strictEqual(path[0], 'cycle-a');
      assert.strictEqual(path[path.length - 1], 'cycle-c');
    });

    it('should handle missing relation targets', () => {
      store('broken-a', 'A', { relations: ['nonexistent', 'broken-b'] });
      store('broken-b', 'B');

      const path = findPathBFS('broken-a', 'broken-b');
      assert.deepStrictEqual(path, ['broken-a', 'broken-b']);
    });
  });

  describe('findPathDFS', () => {
    it('should find a path using depth-first search', () => {
      store('dfs-a', 'A', { relations: ['dfs-b'] });
      store('dfs-b', 'B', { relations: ['dfs-c'] });
      store('dfs-c', 'C');

      const path = findPathDFS('dfs-a', 'dfs-c');
      assert.ok(path);
      assert.deepStrictEqual(path, ['dfs-a', 'dfs-b', 'dfs-c']);
    });

    it('should respect maxDepth limit', () => {
      store('deep-a', 'A', { relations: ['deep-b'] });
      store('deep-b', 'B', { relations: ['deep-c'] });
      store('deep-c', 'C', { relations: ['deep-d'] });
      store('deep-d', 'D');

      const path = findPathDFS('deep-a', 'deep-d', 2);
      assert.strictEqual(path, null, 'Should not find path beyond maxDepth');
    });

    it('should return null for invalid inputs', () => {
      assert.strictEqual(findPathDFS('', 'x'), null);
      assert.strictEqual(findPathDFS(123, 'x'), null);
    });

    it('should handle self-loops', () => {
      store('selfloop', 'Self', { relations: ['selfloop'] });
      const path = findPathDFS('selfloop', 'selfloop');
      assert.deepStrictEqual(path, ['selfloop']);
    });
  });

  describe('findAllPaths', () => {
    it('should find multiple paths between nodes', () => {
      store('multi-a', 'A', { relations: ['multi-b', 'multi-c'] });
      store('multi-b', 'B', { relations: ['multi-d'] });
      store('multi-c', 'C', { relations: ['multi-d'] });
      store('multi-d', 'D');

      const paths = findAllPaths('multi-a', 'multi-d');
      assert.ok(paths.length >= 2, 'Should find at least 2 paths');
      assert.ok(paths.every((p) => p[0] === 'multi-a' && p[p.length - 1] === 'multi-d'));
    });

    it('should respect maxPaths limit', () => {
      store('limit-a', 'A', { relations: ['limit-b', 'limit-c', 'limit-d'] });
      store('limit-b', 'B', { relations: ['limit-e'] });
      store('limit-c', 'C', { relations: ['limit-e'] });
      store('limit-d', 'D', { relations: ['limit-e'] });
      store('limit-e', 'E');

      const paths = findAllPaths('limit-a', 'limit-e', 2);
      assert.ok(paths.length <= 2, 'Should respect maxPaths limit');
    });

    it('should return empty array for no paths', () => {
      store('nope-a', 'A');
      store('nope-b', 'B');
      const paths = findAllPaths('nope-a', 'nope-b');
      assert.deepStrictEqual(paths, []);
    });

    it('should handle invalid inputs', () => {
      assert.deepStrictEqual(findAllPaths(null, 'x'), []);
      assert.deepStrictEqual(findAllPaths('x', null), []);
    });
  });

  describe('getPathDistance', () => {
    it('should return correct distance for connected nodes', () => {
      store('dist-a', 'A', { relations: ['dist-b'] });
      store('dist-b', 'B', { relations: ['dist-c'] });
      store('dist-c', 'C');

      assert.strictEqual(getPathDistance('dist-a', 'dist-c'), 2);
      assert.strictEqual(getPathDistance('dist-a', 'dist-b'), 1);
      assert.strictEqual(getPathDistance('dist-a', 'dist-a'), 0);
    });

    it('should return null for unreachable nodes', () => {
      store('far-a', 'A');
      store('far-b', 'B');
      assert.strictEqual(getPathDistance('far-a', 'far-b'), null);
    });

    it('should handle invalid inputs', () => {
      assert.strictEqual(getPathDistance('', 'x'), null);
      assert.strictEqual(getPathDistance(undefined, 'x'), null);
    });
  });
});

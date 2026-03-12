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
});

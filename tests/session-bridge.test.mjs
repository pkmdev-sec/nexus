import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  saveSessionSummary,
  loadSessionSummary,
  findRelevantSessions,
  mergeContexts,
} from '../lib/session-bridge.mjs';

const SESSIONS_DIR = join(process.env.HOME, '.nexus', 'sessions');
const TEST_PREFIX = '__nexus_test_';

function cleanup() {
  if (!existsSync(SESSIONS_DIR)) return;
  for (const f of readdirSync(SESSIONS_DIR)) {
    if (f.startsWith(TEST_PREFIX)) {
      rmSync(join(SESSIONS_DIR, f));
    }
  }
}

describe('session-bridge', () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  // -- saveSessionSummary & loadSessionSummary --

  it('should save and load a session summary', () => {
    const id = `${TEST_PREFIX}session-1`;
    const summary = { decisions: [{ text: 'Use React' }], tasks: [] };
    const result = saveSessionSummary(id, summary);
    assert.ok(result.saved);
    assert.ok(result.path);

    const loaded = loadSessionSummary(id);
    assert.ok(loaded);
    assert.strictEqual(loaded.sessionId, id);
    assert.deepStrictEqual(loaded.summary, summary);
  });

  it('should return null for non-existent session', () => {
    const result = loadSessionSummary(`${TEST_PREFIX}nonexistent`);
    assert.strictEqual(result, null);
  });

  it('should overwrite existing session', () => {
    const id = `${TEST_PREFIX}overwrite`;
    saveSessionSummary(id, { v: 1 });
    saveSessionSummary(id, { v: 2 });
    const loaded = loadSessionSummary(id);
    assert.deepStrictEqual(loaded.summary, { v: 2 });
  });

  // -- findRelevantSessions --

  it('should find sessions by content string', () => {
    saveSessionSummary(`${TEST_PREFIX}react-proj`, { decisions: [{ text: 'React with TypeScript' }] });
    saveSessionSummary(`${TEST_PREFIX}vue-proj`, { decisions: [{ text: 'Vue with Pinia' }] });

    const results = findRelevantSessions('React');
    assert.ok(results.length >= 1);
    assert.ok(results.some((r) => r.sessionId === `${TEST_PREFIX}react-proj`));
  });

  it('should find sessions by regex', () => {
    saveSessionSummary(`${TEST_PREFIX}api-work`, { tasks: [{ task: 'Build REST API' }] });

    const results = findRelevantSessions(/REST\s+API/i);
    assert.ok(results.length >= 1);
  });

  it('should return empty for no matches', () => {
    saveSessionSummary(`${TEST_PREFIX}something`, { data: 'hello' });
    const results = findRelevantSessions('ZZZZNOTFOUND');
    assert.strictEqual(results.length, 0);
  });

  it('should sort by most recent first', () => {
    saveSessionSummary(`${TEST_PREFIX}old`, { keyword: 'shared' });
    // Small delay to ensure different timestamps
    saveSessionSummary(`${TEST_PREFIX}new`, { keyword: 'shared' });

    const results = findRelevantSessions('shared');
    assert.ok(results.length >= 2);
    const newTime = new Date(results[0].savedAt).getTime();
    const oldTime = new Date(results[1].savedAt).getTime();
    assert.ok(newTime >= oldTime, 'Should be sorted newest first');
  });

  // -- mergeContexts --

  it('should merge multiple session contexts', () => {
    const sessions = [
      { summary: { decisions: [{ id: 'd1', text: 'Use React' }], tasks: [{ id: 't1', task: 'Setup' }], codeChanges: [], patterns: [] } },
      { summary: { decisions: [{ id: 'd2', text: 'Use Jest' }], tasks: [{ id: 't2', task: 'Write tests' }], codeChanges: [], patterns: [] } },
    ];

    const merged = mergeContexts(sessions);
    assert.strictEqual(merged.sessionCount, 2);
    assert.strictEqual(merged.decisions.length, 2);
    assert.strictEqual(merged.tasks.length, 2);
  });

  it('should deduplicate by id', () => {
    const sessions = [
      { summary: { decisions: [{ id: 'same', text: 'A' }], tasks: [], codeChanges: [], patterns: [] } },
      { summary: { decisions: [{ id: 'same', text: 'A' }], tasks: [], codeChanges: [], patterns: [] } },
    ];

    const merged = mergeContexts(sessions);
    assert.strictEqual(merged.decisions.length, 1);
  });

  it('should handle empty sessions', () => {
    const merged = mergeContexts([]);
    assert.strictEqual(merged.sessionCount, 0);
    assert.deepStrictEqual(merged.decisions, []);
  });

  it('should handle sessions with missing fields', () => {
    const sessions = [{ summary: {} }, { summary: { decisions: [{ id: 'x' }] } }];
    const merged = mergeContexts(sessions);
    assert.strictEqual(merged.decisions.length, 1);
  });
});

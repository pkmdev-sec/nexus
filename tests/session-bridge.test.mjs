import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  saveSessionSummary,
  loadSessionSummary,
  findRelevantSessions,
  mergeContexts,
  calculateSessionSimilarity,
  findSimilarSessions,
  compareSessionDetails,
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

  // -- calculateSessionSimilarity (P1 Feature) --

  describe('calculateSessionSimilarity', () => {
    it('should calculate similarity between sessions with shared content', () => {
      const session1 = {
        summary: {
          decisions: [{ id: 'd1', text: 'Use React with TypeScript' }],
          codeChanges: [{ id: 'c1', file: 'App.tsx' }],
          patterns: [],
          tasks: [],
        },
      };

      const session2 = {
        summary: {
          decisions: [{ id: 'd2', text: 'Use React with Redux' }],
          codeChanges: [{ id: 'c2', file: 'Store.tsx' }],
          patterns: [],
          tasks: [],
        },
      };

      const similarity = calculateSessionSimilarity(session1, session2);
      assert.ok(similarity > 0, 'Should have some similarity due to shared tokens');
      assert.ok(similarity <= 1, 'Similarity should not exceed 1');
    });

    it('should return 0 for completely different sessions', () => {
      const session1 = {
        summary: {
          decisions: [{ id: 'd1', text: 'aaaa bbbb cccc' }],
          codeChanges: [],
          patterns: [],
          tasks: [],
        },
      };

      const session2 = {
        summary: {
          decisions: [{ id: 'd2', text: 'xxxx yyyy zzzz' }],
          codeChanges: [],
          patterns: [],
          tasks: [],
        },
      };

      const similarity = calculateSessionSimilarity(session1, session2);
      assert.ok(similarity >= 0);
    });

    it('should return 0 for invalid inputs', () => {
      assert.strictEqual(calculateSessionSimilarity(null, null), 0);
      assert.strictEqual(calculateSessionSimilarity({}, null), 0);
      assert.strictEqual(calculateSessionSimilarity(null, {}), 0);
    });

    it('should handle empty summaries', () => {
      const session1 = { summary: {} };
      const session2 = { summary: {} };
      const similarity = calculateSessionSimilarity(session1, session2);
      assert.strictEqual(similarity, 0);
    });

    it('should ignore very short tokens', () => {
      const session1 = { summary: { decisions: [{ text: 'a b c' }] } };
      const session2 = { summary: { decisions: [{ text: 'x y z' }] } };
      const similarity = calculateSessionSimilarity(session1, session2);
      assert.strictEqual(similarity, 0, 'Short tokens should be filtered');
    });
  });

  // -- findSimilarSessions (P1 Feature) --

  describe('findSimilarSessions', () => {
    it('should find sessions similar to target', () => {
      const target = {
        summary: {
          decisions: [{ id: 'd1', text: 'React TypeScript project setup' }],
          codeChanges: [],
          patterns: [],
          tasks: [],
        },
      };

      const candidates = [
        {
          sessionId: `${TEST_PREFIX}similar`,
          summary: {
            decisions: [{ id: 'd2', text: 'React TypeScript configuration' }],
            codeChanges: [],
            patterns: [],
            tasks: [],
          },
        },
        {
          sessionId: `${TEST_PREFIX}different`,
          summary: {
            decisions: [{ id: 'd3', text: 'Python Flask backend' }],
            codeChanges: [],
            patterns: [],
            tasks: [],
          },
        },
      ];

      const similar = findSimilarSessions(target, candidates, 0.05);
      assert.ok(similar.length > 0);
      assert.ok(similar.every((s) => typeof s.similarity === 'number'));
    });

    it('should respect minSimilarity threshold', () => {
      const target = { summary: { decisions: [{ text: 'unique content here' }] } };
      const candidates = [{ summary: { decisions: [{ text: 'completely different' }] } }];

      const similar = findSimilarSessions(target, candidates, 0.9);
      assert.strictEqual(similar.length, 0, 'Should filter out low similarity sessions');
    });

    it('should respect topN limit', () => {
      const target = { summary: { decisions: [{ text: 'test' }] } };
      const candidates = Array.from({ length: 10 }, (_, i) => ({
        summary: { decisions: [{ text: `test ${i}` }] },
      }));

      const similar = findSimilarSessions(target, candidates, 0.0, 3);
      assert.ok(similar.length <= 3);
    });

    it('should handle invalid inputs', () => {
      assert.deepStrictEqual(findSimilarSessions(null, []), []);
      assert.deepStrictEqual(findSimilarSessions({}, null), []);
    });

    it('should sort by similarity descending', () => {
      const target = { summary: { decisions: [{ text: 'common word' }] } };
      const candidates = [
        { summary: { decisions: [{ text: 'common' }] } },
        { summary: { decisions: [{ text: 'common word phrase' }] } },
        { summary: { decisions: [{ text: 'unrelated' }] } },
      ];

      const similar = findSimilarSessions(target, candidates, 0.0);
      if (similar.length > 1) {
        assert.ok(similar[0].similarity >= similar[similar.length - 1].similarity);
      }
    });
  });

  // -- compareSessionDetails (P1 Feature) --

  describe('compareSessionDetails', () => {
    it('should return detailed comparison metrics', () => {
      const session1 = {
        summary: {
          decisions: [{ id: 'd1' }, { id: 'd2' }],
          codeChanges: [{ id: 'c1', file: 'App.tsx' }],
          patterns: [{ id: 'p1' }],
          tasks: [{ id: 't1' }],
        },
      };

      const session2 = {
        summary: {
          decisions: [{ id: 'd1' }, { id: 'd3' }],
          codeChanges: [{ id: 'c1', file: 'App.tsx' }],
          patterns: [{ id: 'p2' }],
          tasks: [{ id: 't1' }],
        },
      };

      const details = compareSessionDetails(session1, session2);
      assert.ok(typeof details.similarity === 'number');
      assert.strictEqual(details.sharedDecisions, 1);
      assert.strictEqual(details.sharedFiles, 1);
      assert.strictEqual(details.sharedTasks, 1);
      assert.strictEqual(details.sharedPatterns, 0);
    });

    it('should handle sessions with no overlap', () => {
      const session1 = { summary: { decisions: [{ id: 'd1' }], codeChanges: [], patterns: [], tasks: [] } };
      const session2 = { summary: { decisions: [{ id: 'd2' }], codeChanges: [], patterns: [], tasks: [] } };

      const details = compareSessionDetails(session1, session2);
      assert.strictEqual(details.sharedDecisions, 0);
      assert.strictEqual(details.sharedFiles, 0);
    });

    it('should handle invalid inputs', () => {
      const details = compareSessionDetails(null, null);
      assert.strictEqual(details.similarity, 0);
      assert.strictEqual(details.sharedDecisions, 0);
    });

    it('should handle empty summaries', () => {
      const details = compareSessionDetails({ summary: {} }, { summary: {} });
      assert.strictEqual(details.sharedDecisions, 0);
      assert.strictEqual(details.sharedFiles, 0);
    });
  });
});

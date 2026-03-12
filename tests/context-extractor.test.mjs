import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractDecisions,
  extractCodeChanges,
  extractPatterns,
  extractTasks,
  createSnapshot,
  calculateImportance,
  addImportanceScores,
  sortByImportance,
} from '../lib/context-extractor.mjs';

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const MESSAGES = [
  { role: 'user', content: 'We should use React for the frontend.' },
  { role: 'assistant', content: "Decided to use React with TypeScript.\nI'll create the project structure." },
  { role: 'assistant', content: 'Created file src/App.tsx with the main component.\nModified package.json to add dependencies.' },
  { role: 'user', content: 'We always use camelCase for variables — that is the convention.' },
  { role: 'assistant', content: 'TODO: add unit tests for the login page\n[x] Setup routing\n[ ] Implement auth flow' },
  { role: 'user', content: 'The project uses ESLint with the airbnb config.' },
  { role: 'assistant', content: 'Updated src/utils/helpers.ts:42 with the fix.\nRefactored file src/components/Header.tsx' },
];

// ---------------------------------------------------------------------------
// extractDecisions
// ---------------------------------------------------------------------------

describe('extractDecisions', () => {
  it('should find decision keywords in messages', () => {
    const decisions = extractDecisions(MESSAGES);
    assert.ok(decisions.length > 0, 'Should extract at least one decision');
  });

  it('should include speaker and timestamp', () => {
    const decisions = extractDecisions(MESSAGES);
    for (const d of decisions) {
      assert.ok(d.speaker, 'Each decision should have a speaker');
      assert.ok(d.ts, 'Each decision should have a timestamp');
      assert.ok(d.id, 'Each decision should have an id');
    }
  });

  it('should return empty array for no decisions', () => {
    const result = extractDecisions([{ role: 'user', content: 'Hello world' }]);
    assert.deepStrictEqual(result, []);
  });

  it('should handle empty messages array', () => {
    assert.deepStrictEqual(extractDecisions([]), []);
  });

  it('should handle messages with no content', () => {
    const result = extractDecisions([{ role: 'user' }]);
    assert.deepStrictEqual(result, []);
  });
});

// ---------------------------------------------------------------------------
// extractCodeChanges
// ---------------------------------------------------------------------------

describe('extractCodeChanges', () => {
  it('should detect file modifications', () => {
    const changes = extractCodeChanges(MESSAGES);
    assert.ok(changes.length > 0, 'Should detect code changes');
  });

  it('should extract file paths', () => {
    const changes = extractCodeChanges(MESSAGES);
    const files = changes.map((c) => c.file);
    assert.ok(files.some((f) => f.includes('.tsx') || f.includes('.ts') || f.includes('.json')));
  });

  it('should extract action verbs', () => {
    const changes = extractCodeChanges(MESSAGES);
    const actions = changes.map((c) => c.action);
    assert.ok(
      actions.some((a) => ['created', 'modified', 'updated', 'refactored'].includes(a)),
      `Actions should include known verbs, got: ${actions}`,
    );
  });

  it('should deduplicate by file+action', () => {
    const dupeMessages = [
      { role: 'assistant', content: 'Created file test.js.\nCreated file test.js again.' },
    ];
    const changes = extractCodeChanges(dupeMessages);
    const testJs = changes.filter((c) => c.file === 'test.js' && c.action === 'created');
    assert.ok(testJs.length <= 1, 'Should deduplicate');
  });

  it('should return empty for no code changes', () => {
    const result = extractCodeChanges([{ role: 'user', content: 'Just chatting' }]);
    assert.deepStrictEqual(result, []);
  });
});

// ---------------------------------------------------------------------------
// extractPatterns
// ---------------------------------------------------------------------------

describe('extractPatterns', () => {
  it('should detect convention patterns', () => {
    const patterns = extractPatterns(MESSAGES);
    assert.ok(patterns.length > 0, 'Should find patterns');
  });

  it('should capture pattern text', () => {
    const patterns = extractPatterns(MESSAGES);
    const texts = patterns.map((p) => p.pattern);
    assert.ok(
      texts.some((t) => /convention|uses|always/i.test(t)),
      'Should capture pattern text with signal words',
    );
  });

  it('should skip very short lines', () => {
    const result = extractPatterns([{ role: 'user', content: 'always x' }]);
    assert.deepStrictEqual(result, [], 'Lines under 15 chars should be ignored');
  });
});

// ---------------------------------------------------------------------------
// extractTasks
// ---------------------------------------------------------------------------

describe('extractTasks', () => {
  it('should detect TODO items', () => {
    const tasks = extractTasks(MESSAGES);
    assert.ok(tasks.length > 0, 'Should find tasks');
  });

  it('should detect checkbox states', () => {
    const tasks = extractTasks(MESSAGES);
    const completed = tasks.filter((t) => t.status === 'completed');
    const pending = tasks.filter((t) => t.status === 'pending');
    assert.ok(completed.length > 0, 'Should find completed tasks');
    assert.ok(pending.length > 0, 'Should find pending tasks');
  });

  it('should skip very short text', () => {
    const result = extractTasks([{ role: 'user', content: '[ ] ab' }]);
    assert.deepStrictEqual(result, []);
  });

  it('should handle empty input', () => {
    assert.deepStrictEqual(extractTasks([]), []);
  });
});

// ---------------------------------------------------------------------------
// createSnapshot
// ---------------------------------------------------------------------------

describe('createSnapshot', () => {
  it('should create a full snapshot with all fields', () => {
    const snap = createSnapshot(MESSAGES);
    assert.ok(snap.id.startsWith('snap-'));
    assert.ok(snap.ts);
    assert.ok(Array.isArray(snap.decisions));
    assert.ok(Array.isArray(snap.codeChanges));
    assert.ok(Array.isArray(snap.patterns));
    assert.ok(Array.isArray(snap.tasks));
    assert.strictEqual(snap.messageCount, MESSAGES.length);
  });

  it('should work with empty messages', () => {
    const snap = createSnapshot([]);
    assert.strictEqual(snap.messageCount, 0);
    assert.deepStrictEqual(snap.decisions, []);
  });
});

// ---------------------------------------------------------------------------
// calculateImportance (P1 Feature)
// ---------------------------------------------------------------------------

describe('calculateImportance', () => {
  it('should calculate importance score for decisions', () => {
    const item = { text: 'Use React', ts: new Date().toISOString() };
    const score = calculateImportance(item, [], 'decision');
    assert.ok(score > 0 && score <= 100);
  });

  it('should give higher scores to recent items', () => {
    const recent = { text: 'Recent', ts: new Date().toISOString() };
    const old = { text: 'Old', ts: '2020-01-01T00:00:00.000Z' };

    const recentScore = calculateImportance(recent, [recent, old], 'decision');
    const oldScore = calculateImportance(old, [recent, old], 'decision');

    assert.ok(recentScore > oldScore, 'Recent items should score higher');
  });

  it('should give higher scores for longer content', () => {
    const long = { text: 'x'.repeat(150), ts: new Date().toISOString() };
    const short = { text: 'x', ts: new Date().toISOString() };

    const longScore = calculateImportance(long, [long, short], 'decision');
    const shortScore = calculateImportance(short, [long, short], 'decision');

    assert.ok(longScore > shortScore, 'Longer content should score higher');
  });

  it('should handle invalid inputs gracefully', () => {
    assert.strictEqual(calculateImportance(null), 0);
    assert.strictEqual(calculateImportance(undefined), 0);
    const emptyScore = calculateImportance({});
    assert.ok(emptyScore >= 0 && emptyScore <= 100, 'Empty object should return valid score');
  });

  it('should respect type weights', () => {
    const item = { text: 'Test', ts: new Date().toISOString() };
    const decisionScore = calculateImportance(item, [], 'decision');
    const codeScore = calculateImportance(item, [], 'code');
    const patternScore = calculateImportance(item, [], 'pattern');

    assert.ok(decisionScore > 0);
    assert.ok(codeScore > 0);
    assert.ok(patternScore > 0);
  });

  it('should handle items without timestamps', () => {
    const item = { text: 'No timestamp' };
    const score = calculateImportance(item, [], 'decision');
    assert.ok(score > 0);
  });
});

// ---------------------------------------------------------------------------
// addImportanceScores (P1 Feature)
// ---------------------------------------------------------------------------

describe('addImportanceScores', () => {
  it('should add importance scores to all items', () => {
    const items = [
      { text: 'Item 1', ts: new Date().toISOString() },
      { text: 'Item 2', ts: new Date().toISOString() },
    ];

    const scored = addImportanceScores(items, 'decision');
    assert.strictEqual(scored.length, 2);
    assert.ok(scored.every((item) => typeof item.importance === 'number'));
  });

  it('should handle empty arrays', () => {
    const scored = addImportanceScores([], 'decision');
    assert.deepStrictEqual(scored, []);
  });

  it('should handle non-array inputs', () => {
    const scored = addImportanceScores(null, 'decision');
    assert.deepStrictEqual(scored, []);
  });

  it('should preserve original item properties', () => {
    const items = [{ text: 'Test', id: 'test-1', ts: new Date().toISOString() }];
    const scored = addImportanceScores(items, 'task');
    assert.strictEqual(scored[0].text, 'Test');
    assert.strictEqual(scored[0].id, 'test-1');
    assert.ok(scored[0].importance);
  });
});

// ---------------------------------------------------------------------------
// sortByImportance (P1 Feature)
// ---------------------------------------------------------------------------

describe('sortByImportance', () => {
  it('should sort items by importance descending', () => {
    const items = [
      { text: 'Low', importance: 10 },
      { text: 'High', importance: 90 },
      { text: 'Medium', importance: 50 },
    ];

    const sorted = sortByImportance(items);
    assert.strictEqual(sorted[0].importance, 90);
    assert.strictEqual(sorted[1].importance, 50);
    assert.strictEqual(sorted[2].importance, 10);
  });

  it('should handle items without importance scores', () => {
    const items = [{ text: 'No score' }, { text: 'Has score', importance: 100 }];
    const sorted = sortByImportance(items);
    assert.strictEqual(sorted[0].importance, 100);
  });

  it('should handle empty arrays', () => {
    const sorted = sortByImportance([]);
    assert.deepStrictEqual(sorted, []);
  });

  it('should not mutate original array', () => {
    const items = [
      { text: 'A', importance: 10 },
      { text: 'B', importance: 20 },
    ];
    const original = [...items];
    sortByImportance(items);
    assert.deepStrictEqual(items, original);
  });

  it('should handle invalid inputs', () => {
    const sorted = sortByImportance(null);
    assert.deepStrictEqual(sorted, []);
  });
});

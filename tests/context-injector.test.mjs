import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectRelevant,
  formatForInjection,
  estimateTokens,
  inject,
  applyRelevanceDecay,
  reRankWithDecay,
  getAgeWeight,
} from '../lib/context-injector.mjs';

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const KNOWLEDGE = [
  { key: 'react-setup', value: 'Using React with TypeScript and Vite', metadata: { updatedAt: new Date().toISOString(), tags: ['react'] } },
  { key: 'auth-flow', value: 'JWT-based authentication with refresh tokens', metadata: { updatedAt: new Date().toISOString(), tags: ['auth'] } },
  { key: 'db-schema', value: 'PostgreSQL with Prisma ORM', metadata: { updatedAt: new Date().toISOString(), tags: ['database'] } },
  { key: 'old-decision', value: 'Decided to use tabs over spaces', metadata: { updatedAt: '2020-01-01T00:00:00.000Z', tags: ['style'] } },
  { key: 'pinned-note', value: 'Always run tests before pushing', metadata: { updatedAt: '2020-01-01T00:00:00.000Z', pinned: true, tags: ['workflow'] } },
];

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

describe('estimateTokens', () => {
  it('should estimate tokens for a string', () => {
    const tokens = estimateTokens('Hello world, this is a test string.');
    assert.ok(tokens > 0);
    assert.ok(tokens < 100);
  });

  it('should estimate tokens for an array of entries', () => {
    const tokens = estimateTokens(KNOWLEDGE);
    assert.ok(tokens > 0);
  });

  it('should return 0 for empty input', () => {
    assert.strictEqual(estimateTokens(''), 0);
  });

  it('should return higher count for longer text', () => {
    const short = estimateTokens('short');
    const long = estimateTokens('This is a much longer piece of text that should have more tokens.');
    assert.ok(long > short);
  });
});

// ---------------------------------------------------------------------------
// selectRelevant
// ---------------------------------------------------------------------------

describe('selectRelevant', () => {
  it('should return entries sorted by relevance', () => {
    const result = selectRelevant('React TypeScript setup', KNOWLEDGE);
    assert.ok(result.length > 0);
    assert.ok(result.length <= KNOWLEDGE.length);
  });

  it('should prefer matching entries', () => {
    const result = selectRelevant('authentication JWT tokens', KNOWLEDGE);
    assert.ok(result.length > 0);
    // Auth-related entry should be near the top
    const authIdx = result.findIndex((e) => e.key === 'auth-flow');
    assert.ok(authIdx < 3, `Auth entry should be in top 3, was at index ${authIdx}`);
  });

  it('should respect topK limit', () => {
    const result = selectRelevant('anything', KNOWLEDGE, 2);
    assert.ok(result.length <= 2);
  });

  it('should handle empty knowledge', () => {
    const result = selectRelevant('test', []);
    assert.deepStrictEqual(result, []);
  });

  it('should handle empty task string', () => {
    const result = selectRelevant('', KNOWLEDGE);
    assert.ok(Array.isArray(result), 'Should return an array for empty task');
  });
});

// ---------------------------------------------------------------------------
// formatForInjection
// ---------------------------------------------------------------------------

describe('formatForInjection', () => {
  it('should format as system-reminder block', () => {
    const formatted = formatForInjection(KNOWLEDGE.slice(0, 2));
    assert.ok(formatted.includes('<system-reminder>'));
    assert.ok(formatted.includes('</system-reminder>'));
    assert.ok(formatted.includes('Nexus'));
  });

  it('should include entry keys as headings', () => {
    const formatted = formatForInjection([KNOWLEDGE[0]]);
    assert.ok(formatted.includes('react-setup'));
  });

  it('should return empty string for empty entries', () => {
    assert.strictEqual(formatForInjection([]), '');
    assert.strictEqual(formatForInjection(null), '');
  });
});

// ---------------------------------------------------------------------------
// inject
// ---------------------------------------------------------------------------

describe('inject', () => {
  it('should return payload within token budget', () => {
    const result = inject(KNOWLEDGE, 2000);
    assert.ok(result.payload.length > 0);
    assert.ok(result.estimatedTokens <= 2000);
    assert.ok(result.included > 0);
  });

  it('should skip entries that exceed budget', () => {
    const bigEntry = { key: 'huge', value: 'x'.repeat(10000), metadata: {} };
    const result = inject([bigEntry], 100);
    assert.strictEqual(result.included, 0);
  });

  it('should include as many entries as fit', () => {
    const result = inject(KNOWLEDGE, 50000);
    assert.strictEqual(result.included, KNOWLEDGE.length);
  });

  it('should handle empty entries', () => {
    const result = inject([], 2000);
    assert.strictEqual(result.included, 0);
  });
});

// ---------------------------------------------------------------------------
// applyRelevanceDecay (P1 Feature)
// ---------------------------------------------------------------------------

describe('applyRelevanceDecay', () => {
  it('should add decayedScore to entries', () => {
    const entries = [
      { key: 'recent', value: 'Recent', metadata: { updatedAt: new Date().toISOString() } },
      { key: 'old', value: 'Old', metadata: { updatedAt: '2020-01-01T00:00:00.000Z' } },
    ];

    const decayed = applyRelevanceDecay(entries);
    assert.strictEqual(decayed.length, 2);
    assert.ok(decayed.every((e) => typeof e.decayedScore === 'number'));
  });

  it('should give higher scores to recent entries', () => {
    const entries = [
      { key: 'recent', value: 'R', metadata: { updatedAt: new Date().toISOString() } },
      { key: 'old', value: 'O', metadata: { updatedAt: '2020-01-01T00:00:00.000Z' } },
    ];

    const decayed = applyRelevanceDecay(entries);
    const recentScore = decayed.find((e) => e.key === 'recent').decayedScore;
    const oldScore = decayed.find((e) => e.key === 'old').decayedScore;

    assert.ok(recentScore > oldScore, 'Recent entries should have higher decay scores');
  });

  it('should preserve pinned entries when option is set', () => {
    const entries = [
      { key: 'pinned', value: 'P', metadata: { updatedAt: '2020-01-01T00:00:00.000Z', pinned: true } },
    ];

    const decayed = applyRelevanceDecay(entries, { preservePinned: true });
    assert.strictEqual(decayed[0].decayedScore, 1.0);
  });

  it('should handle entries without timestamps', () => {
    const entries = [{ key: 'no-ts', value: 'X' }];
    const decayed = applyRelevanceDecay(entries);
    assert.ok(decayed[0].decayedScore >= 0 && decayed[0].decayedScore <= 1);
  });

  it('should handle empty arrays', () => {
    const decayed = applyRelevanceDecay([]);
    assert.deepStrictEqual(decayed, []);
  });

  it('should handle non-array inputs', () => {
    const decayed = applyRelevanceDecay(null);
    assert.deepStrictEqual(decayed, []);
  });

  it('should apply maxAge penalty', () => {
    const veryOld = new Date(Date.now() - 30 * 86_400_000).toISOString(); // 30 days old
    const entries = [{ key: 'ancient', value: 'A', metadata: { updatedAt: veryOld } }];

    const decayed = applyRelevanceDecay(entries, { maxAge: 7 * 86_400_000 }); // 7 days
    assert.ok(decayed[0].decayedScore < 0.5, 'Very old entries should have low scores');
  });
});

// ---------------------------------------------------------------------------
// reRankWithDecay (P1 Feature)
// ---------------------------------------------------------------------------

describe('reRankWithDecay', () => {
  it('should re-rank entries with combined score', () => {
    const entries = [
      { key: 'a', value: 'A', score: 0.9, metadata: { updatedAt: '2020-01-01T00:00:00.000Z' } },
      { key: 'b', value: 'B', score: 0.3, metadata: { updatedAt: new Date().toISOString() } },
    ];

    const ranked = reRankWithDecay(entries);
    assert.strictEqual(ranked.length, 2);
    assert.ok(ranked.every((e) => typeof e.combinedScore === 'number'));
  });

  it('should sort by combined score', () => {
    const entries = [
      { key: 'low', value: 'L', score: 0.2, metadata: { updatedAt: '2020-01-01T00:00:00.000Z' } },
      { key: 'high', value: 'H', score: 0.9, metadata: { updatedAt: new Date().toISOString() } },
    ];

    const ranked = reRankWithDecay(entries);
    assert.strictEqual(ranked[0].key, 'high', 'Highest combined score should be first');
  });

  it('should handle entries without scores', () => {
    const entries = [
      { key: 'no-score', value: 'X', metadata: { updatedAt: new Date().toISOString() } },
    ];

    const ranked = reRankWithDecay(entries);
    assert.ok(ranked[0].combinedScore >= 0);
  });

  it('should handle empty arrays', () => {
    const ranked = reRankWithDecay([]);
    assert.deepStrictEqual(ranked, []);
  });

  it('should handle invalid inputs', () => {
    const ranked = reRankWithDecay(null);
    assert.deepStrictEqual(ranked, []);
  });
});

// ---------------------------------------------------------------------------
// getAgeWeight (P1 Feature)
// ---------------------------------------------------------------------------

describe('getAgeWeight', () => {
  it('should return weight between 0 and 1', () => {
    const entry = { metadata: { updatedAt: new Date().toISOString() } };
    const weight = getAgeWeight(entry);
    assert.ok(weight >= 0 && weight <= 1);
  });

  it('should give higher weight to recent entries', () => {
    const recent = { metadata: { updatedAt: new Date().toISOString() } };
    const old = { metadata: { updatedAt: '2020-01-01T00:00:00.000Z' } };

    const recentWeight = getAgeWeight(recent);
    const oldWeight = getAgeWeight(old);

    assert.ok(recentWeight > oldWeight, 'Recent entries should have higher weights');
  });

  it('should handle entries without timestamps', () => {
    const entry = { key: 'no-ts' };
    const weight = getAgeWeight(entry);
    assert.strictEqual(weight, 0.5);
  });

  it('should respect custom half-life', () => {
    const entry = { metadata: { updatedAt: new Date(Date.now() - 7 * 86_400_000).toISOString() } };
    const weight7 = getAgeWeight(entry, 7);
    assert.ok(Math.abs(weight7 - 0.5) < 0.01, 'Weight should be ~0.5 at half-life');
  });

  it('should handle invalid inputs', () => {
    assert.strictEqual(getAgeWeight(null), 0.5);
    assert.strictEqual(getAgeWeight(undefined), 0.5);
  });
});

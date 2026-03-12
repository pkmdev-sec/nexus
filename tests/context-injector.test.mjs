import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectRelevant,
  formatForInjection,
  estimateTokens,
  inject,
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

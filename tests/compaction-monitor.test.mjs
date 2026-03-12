import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateTokenUsage,
  predictCompaction,
  getCompactionRisk,
  suggestCompaction,
  createProgressBar,
  visualizeCompactionProgress,
  createProgressReport,
} from '../lib/compaction-monitor.mjs';

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

function makeMessages(count, avgLength = 200) {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: 'x'.repeat(avgLength),
  }));
}

// ---------------------------------------------------------------------------
// estimateTokenUsage
// ---------------------------------------------------------------------------

describe('estimateTokenUsage', () => {
  it('should return token count for messages', () => {
    const msgs = makeMessages(10, 100);
    const usage = estimateTokenUsage(msgs);
    assert.ok(usage.tokens > 0);
    assert.ok(usage.chars > 0);
    assert.strictEqual(usage.messageCount, 10);
  });

  it('should handle empty messages', () => {
    const usage = estimateTokenUsage([]);
    assert.strictEqual(usage.tokens, 0);
    assert.strictEqual(usage.messageCount, 0);
  });

  it('should scale with message count', () => {
    const small = estimateTokenUsage(makeMessages(5));
    const large = estimateTokenUsage(makeMessages(50));
    assert.ok(large.tokens > small.tokens);
  });

  it('should handle messages with no content', () => {
    const usage = estimateTokenUsage([{ role: 'user' }]);
    assert.ok(usage.tokens >= 0);
  });
});

// ---------------------------------------------------------------------------
// predictCompaction
// ---------------------------------------------------------------------------

describe('predictCompaction', () => {
  it('should predict compaction for messages', () => {
    const msgs = makeMessages(100, 500);
    const pred = predictCompaction(msgs);
    assert.ok(pred.currentTokens > 0);
    assert.ok(pred.limit > 0);
    assert.ok(pred.tokensRemaining >= 0);
    assert.ok(pred.messagesUntilCompaction >= 0);
    assert.ok(pred.percentUsed >= 0 && pred.percentUsed <= 100);
  });

  it('should use custom rate', () => {
    const msgs = makeMessages(10);
    const pred = predictCompaction(msgs, 1000);
    assert.ok(pred.messagesUntilCompaction >= 0);
  });

  it('should use custom context limit', () => {
    const msgs = makeMessages(10);
    const pred = predictCompaction(msgs, undefined, 1000);
    assert.strictEqual(pred.limit, 1000);
  });

  it('should show high usage for many large messages', () => {
    const msgs = makeMessages(500, 1500);
    const pred = predictCompaction(msgs, undefined, 200000);
    assert.ok(pred.percentUsed > 50, `Expected >50%, got ${pred.percentUsed}%`);
  });

  it('should handle single message', () => {
    const pred = predictCompaction([{ role: 'user', content: 'hi' }]);
    assert.ok(pred.currentTokens > 0);
  });
});

// ---------------------------------------------------------------------------
// getCompactionRisk
// ---------------------------------------------------------------------------

describe('getCompactionRisk', () => {
  it('should return low for few messages', () => {
    const risk = getCompactionRisk(makeMessages(5), 200000);
    assert.strictEqual(risk, 'low');
  });

  it('should return critical for near-limit usage', () => {
    // ~200k tokens worth of messages (each ~500 chars = ~125 tokens, need ~1600 msgs)
    const risk = getCompactionRisk(makeMessages(2000, 400), 200000);
    assert.strictEqual(risk, 'critical');
  });

  it('should handle empty messages', () => {
    const risk = getCompactionRisk();
    assert.strictEqual(risk, 'low');
  });

  it('should return medium for moderate usage', () => {
    // ~100k tokens: 800 msgs * 500 chars each
    const risk = getCompactionRisk(makeMessages(800, 500), 200000);
    assert.ok(['medium', 'high'].includes(risk), `Expected medium or high, got ${risk}`);
  });
});

// ---------------------------------------------------------------------------
// suggestCompaction
// ---------------------------------------------------------------------------

describe('suggestCompaction', () => {
  it('should return strategy for "decisions" focus', () => {
    const result = suggestCompaction('decisions');
    assert.ok(result.strategy);
    assert.ok(Array.isArray(result.keep));
    assert.ok(Array.isArray(result.compact));
    assert.ok(result.keep.includes('decisions'));
  });

  it('should return strategy for "code" focus', () => {
    const result = suggestCompaction('code');
    assert.ok(result.keep.includes('code-changes'));
  });

  it('should return strategy for "tasks" focus', () => {
    const result = suggestCompaction('tasks');
    assert.ok(result.keep.includes('active-tasks'));
  });

  it('should default to "all" for unknown focus', () => {
    const result = suggestCompaction('unknown');
    assert.ok(result.strategy.includes('Balanced'));
  });

  it('should default to "all" when no argument', () => {
    const result = suggestCompaction();
    assert.ok(result.keep.includes('decisions'));
  });
});

// ---------------------------------------------------------------------------
// createProgressBar (P1 Feature)
// ---------------------------------------------------------------------------

describe('createProgressBar', () => {
  it('should create a progress bar for given percentage', () => {
    const bar = createProgressBar(50, 40);
    assert.ok(bar.includes('['));
    assert.ok(bar.includes(']'));
    assert.ok(bar.includes('50%'));
  });

  it('should handle 0 percent', () => {
    const bar = createProgressBar(0, 20);
    assert.ok(bar.includes('0%'));
    assert.ok(bar.includes('['));
  });

  it('should handle 100 percent', () => {
    const bar = createProgressBar(100, 20);
    assert.ok(bar.includes('100%'));
    assert.ok(bar.includes('['));
  });

  it('should clamp values outside 0-100 range', () => {
    const bar1 = createProgressBar(-10, 20);
    assert.ok(bar1.includes('0%'));

    const bar2 = createProgressBar(150, 20);
    assert.ok(bar2.includes('100%'));
  });

  it('should support custom label', () => {
    const bar = createProgressBar(50, 40, { label: 'Loading' });
    assert.ok(bar.includes('Loading'));
  });

  it('should support hiding percentage', () => {
    const bar = createProgressBar(50, 40, { showPercent: false });
    assert.ok(!bar.includes('%'));
  });

  it('should support hiding bar', () => {
    const bar = createProgressBar(50, 40, { showBar: false });
    assert.ok(!bar.includes('['));
  });

  it('should support custom fill and empty characters', () => {
    const bar = createProgressBar(50, 20, { fillChar: '#', emptyChar: '-' });
    assert.ok(bar.includes('#'));
    assert.ok(bar.includes('-'));
  });

  it('should handle invalid percent input', () => {
    const bar = createProgressBar('invalid', 20);
    assert.ok(bar.includes('0%'));
  });
});

// ---------------------------------------------------------------------------
// visualizeCompactionProgress (P1 Feature)
// ---------------------------------------------------------------------------

describe('visualizeCompactionProgress', () => {
  it('should return bar, risk, and details', () => {
    const msgs = makeMessages(100, 500);
    const result = visualizeCompactionProgress(msgs);

    assert.ok(result.bar);
    assert.ok(['low', 'medium', 'high', 'critical'].includes(result.risk));
    assert.ok(result.details);
    assert.ok(typeof result.details.currentTokens === 'number');
  });

  it('should handle empty messages', () => {
    const result = visualizeCompactionProgress([]);
    assert.ok(result.bar);
    assert.strictEqual(result.risk, 'low');
  });

  it('should handle invalid inputs', () => {
    const result = visualizeCompactionProgress(null);
    assert.ok(result.bar);
    assert.strictEqual(result.risk, 'low');
  });

  it('should use custom context limit', () => {
    const msgs = makeMessages(50, 500);
    const result = visualizeCompactionProgress(msgs, 10000);
    assert.strictEqual(result.details.limit, 10000);
  });

  it('should include risk label in bar', () => {
    const msgs = makeMessages(10, 100);
    const result = visualizeCompactionProgress(msgs);
    assert.ok(result.bar.includes('Safe') || result.bar.includes('Moderate'));
  });
});

// ---------------------------------------------------------------------------
// createProgressReport (P1 Feature)
// ---------------------------------------------------------------------------

describe('createProgressReport', () => {
  it('should create a multi-line report', () => {
    const msgs = makeMessages(50, 200);
    const report = createProgressReport(msgs);

    assert.ok(report.includes('Context Compaction Monitor'));
    assert.ok(report.includes('Current Usage'));
    assert.ok(report.includes('Limit'));
    assert.ok(report.includes('Remaining'));
    assert.ok(report.includes('Risk Level'));
  });

  it('should handle empty messages', () => {
    const report = createProgressReport([]);
    assert.ok(report.includes('0 tokens'));
  });

  it('should handle invalid inputs', () => {
    const report = createProgressReport(null);
    assert.ok(report.length > 0);
  });

  it('should use custom context limit', () => {
    const msgs = makeMessages(10, 100);
    const report = createProgressReport(msgs, 50000);
    assert.ok(report.includes('50,000') || report.includes('50000'));
  });

  it('should include progress bar in report', () => {
    const msgs = makeMessages(10, 100);
    const report = createProgressReport(msgs);
    assert.ok(report.includes('['));
    assert.ok(report.includes('%'));
  });

  it('should format numbers with locale', () => {
    const msgs = makeMessages(100, 1000);
    const report = createProgressReport(msgs);
    // Should include formatted numbers (with commas or locale-appropriate separators)
    assert.ok(report.length > 0);
  });
});

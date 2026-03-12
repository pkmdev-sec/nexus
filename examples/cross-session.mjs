#!/usr/bin/env node
/**
 * Cross-Session Memory — Carry knowledge between Claude Code sessions
 *
 * Demonstrates how Nexus bridges context across separate sessions,
 * finding relevant past knowledge and re-injecting it.
 *
 * Usage: node examples/cross-session.mjs
 */
import { saveSessionSummary, loadSessionSummary, findRelevantSessions, mergeContexts } from '../lib/session-bridge.mjs';
import { store, query } from '../lib/knowledge-graph.mjs';
import { selectRelevant, inject } from '../lib/context-injector.mjs';

console.log('=== Nexus Cross-Session Memory ===\n');

// Simulate saving context from a previous session
const previousSession = {
  id: 'session-001',
  summary: {
    project: 'e-commerce-api',
    decisions: [
      'Using PostgreSQL with Prisma ORM',
      'REST API with Express.js',
      'JWT authentication with refresh tokens'
    ],
    codeChanges: [
      'Created src/db/schema.prisma',
      'Implemented src/auth/jwt.js',
      'Added src/middleware/auth.js'
    ],
    patterns: [
      'Always use async/await over callbacks',
      'Validate input with Zod at controller level'
    ],
    tasks: [
      'TODO: Add rate limiting to auth endpoints',
      'TODO: Set up integration tests'
    ],
    timestamp: new Date(Date.now() - 86400000).toISOString() // yesterday
  }
};

// Save the previous session
saveSessionSummary(previousSession.id, previousSession.summary);
console.log(`Saved session: ${previousSession.id}`);

// Store knowledge nodes from the session
store('db:orm', 'Using Prisma ORM with PostgreSQL', { tags: ['database', 'architecture'] });
store('auth:strategy', 'JWT with refresh tokens, 15min access / 7d refresh', { tags: ['auth', 'security'] });
store('convention:async', 'Always use async/await, never raw callbacks', { tags: ['convention'] });
store('convention:validation', 'Zod validation at controller level', { tags: ['convention'] });

// --- New session starts ---
console.log('\n--- New Session Starting ---\n');

// Find relevant past sessions
const relevant = findRelevantSessions(/e-commerce/);
console.log(`Found ${relevant.length} relevant past sessions`);

if (relevant.length > 0) {
  const merged = mergeContexts(relevant.map(r => r.summary || r));
  console.log(`Merged context: ${merged.decisions?.length || 0} decisions, ${merged.patterns?.length || 0} patterns`);
}

// Select relevant knowledge for current task
const currentTask = 'Add rate limiting middleware to the Express API';
const allKnowledge = query(/.*/);
const selected = selectRelevant(currentTask, allKnowledge, 5);
console.log(`\nRelevant knowledge for: "${currentTask}"`);
selected.forEach(k => console.log(`  - [${k.key}] ${k.value}`));

// Inject as context (respecting token budget)
const { payload, included, estimatedTokens } = inject(selected, 2000);
console.log(`\nInjected ${included} items (${estimatedTokens} tokens)`);
console.log('\n--- Injected Context ---');
console.log(payload);

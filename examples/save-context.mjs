#!/usr/bin/env node
/**
 * Save Context — Save important knowledge before context compaction
 *
 * Demonstrates how to extract and persist key decisions, code changes,
 * patterns, and tasks from a conversation before compaction occurs.
 *
 * Usage: node examples/save-context.mjs
 */
import { createSnapshot, extractDecisions, extractCodeChanges } from '../lib/context-extractor.mjs';
import { store, query, exportGraph } from '../lib/knowledge-graph.mjs';
import { getCompactionRisk, createProgressReport } from '../lib/compaction-monitor.mjs';

// Simulate conversation messages
const messages = [
  { role: 'user', content: 'Let\'s use PostgreSQL for the database. We decided against MongoDB.' },
  { role: 'assistant', content: 'Good choice. I\'ll set up the PostgreSQL schema. Let me create the users table.' },
  { role: 'user', content: 'I created src/db/schema.sql with the initial tables.' },
  { role: 'assistant', content: 'I modified src/db/schema.sql to add proper indexes and constraints.' },
  { role: 'user', content: 'We should always use parameterized queries to prevent SQL injection.' },
  { role: 'assistant', content: 'Agreed. That\'s our convention. TODO: Add input validation middleware.' },
  { role: 'user', content: 'Let\'s go with Express over Fastify for the API framework.' },
  { role: 'assistant', content: 'I\'ll set up Express. Next step: implement the authentication endpoints.' },
];

console.log('=== Nexus Context Preservation ===\n');

// Check compaction risk
const risk = getCompactionRisk(messages, 200000);
console.log(`Compaction risk: ${risk}\n`);

// Extract knowledge from conversation
const decisions = extractDecisions(messages);
console.log(`Decisions found: ${decisions.length}`);
decisions.forEach(d => console.log(`  - ${d.text}`));

const changes = extractCodeChanges(messages);
console.log(`\nCode changes found: ${changes.length}`);
changes.forEach(c => console.log(`  - ${c.file}: ${c.action}`));

// Create a full snapshot
const snapshot = createSnapshot(messages);
console.log(`\nSnapshot created: ${snapshot.id}`);
console.log(`  Decisions: ${snapshot.decisions.length}`);
console.log(`  Code changes: ${snapshot.codeChanges.length}`);
console.log(`  Patterns: ${snapshot.patterns.length}`);
console.log(`  Tasks: ${snapshot.tasks.length}`);

// Store key knowledge in the graph
for (const decision of snapshot.decisions) {
  store(`decision:${decision.id}`, decision.text, {
    tags: ['decision'],
    pinned: true
  });
}

for (const pattern of snapshot.patterns) {
  store(`pattern:${pattern.id}`, pattern.pattern, {
    tags: ['convention', 'pattern']
  });
}

// Query stored knowledge
console.log('\n--- Stored Knowledge ---');
const stored = query(/decision:/);
stored.forEach(n => console.log(`  [${n.key}] ${n.value}`));

// Export the full graph
const graph = exportGraph();
console.log(`\nKnowledge graph: ${Object.keys(graph.nodes || graph).length} nodes`);

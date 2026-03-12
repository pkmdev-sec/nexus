# Context Persistence

## Overview

Context persistence is the fundamental problem Nexus solves. When Claude Code's context window compacts or a session ends, all accumulated knowledge is lost. Nexus intercepts this loss by extracting structured knowledge before it disappears and re-injecting it when needed.

## The Extraction Pipeline

Messages flow through a series of extractors, each specialized for a different type of knowledge:

1. **Decision Extractor** — Identifies statements where choices were made ("decided to use", "going with", "settled on")
2. **Code Change Extractor** — Tracks file modifications with actions (created, modified, deleted) and file paths
3. **Pattern Extractor** — Captures behavioral conventions ("always use", "project uses", "convention is")
4. **Task Extractor** — Pulls pending and completed tasks from TODO markers and checkboxes

## Storage Model

Extracted knowledge is stored as nodes in a JSON-based knowledge graph. Each node has:

- **key** — unique identifier
- **value** — the knowledge payload (string, object, etc.)
- **metadata** — timestamps, tags, relations to other nodes, pinned status

## Injection Strategy

When context needs to be restored, the injector:

1. Scores each knowledge node by **relevance** (Jaccard similarity to current task) and **recency** (decay over 1 week)
2. Selects the top-K entries within a **token budget**
3. Formats them as a system-reminder block for seamless integration

## Lifecycle

```
Session Start → Context Injected → Work Happens → Tools Tracked → Compaction Approaches → Context Extracted → Session Ends → Summary Saved
                    ↑                                                                                                              ↓
                    └──────────────────────────────────── Next Session ←────────────────────────────────────────────────────────────┘
```

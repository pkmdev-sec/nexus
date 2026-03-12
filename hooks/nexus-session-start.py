#!/usr/bin/env python3
"""
nexus-session-start.py — SessionStart Hook

Re-injects relevant past context when a new session begins.
Reads from ~/.nexus/knowledge.json and recent snapshots, selects
the most relevant entries, and outputs a system-reminder block.

Usage in .claude/settings.json:
  "hooks": {
    "SessionStart": [{ "command": "python3 ~/nexus/hooks/nexus-session-start.py" }]
  }
"""

import json
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path

NEXUS_DIR = Path.home() / ".nexus"
KNOWLEDGE_PATH = NEXUS_DIR / "knowledge.json"
SESSIONS_DIR = NEXUS_DIR / "sessions"
SNAPSHOTS_DIR = NEXUS_DIR / "snapshots"

MAX_INJECTION_TOKENS = 2000
AVG_CHARS_PER_TOKEN = 4


def load_knowledge_graph():
    """Load the persistent knowledge graph."""
    if not KNOWLEDGE_PATH.exists():
        return {"nodes": {}}
    try:
        return json.loads(KNOWLEDGE_PATH.read_text())
    except Exception:
        return {"nodes": {}}


def load_recent_snapshots(max_age_hours=72, limit=5):
    """Load the most recent snapshots within the age limit."""
    if not SNAPSHOTS_DIR.exists():
        return []

    cutoff = datetime.utcnow() - timedelta(hours=max_age_hours)
    snapshots = []

    for f in sorted(SNAPSHOTS_DIR.iterdir(), reverse=True):
        if not f.suffix == ".json":
            continue
        try:
            snap = json.loads(f.read_text())
            snap_time = datetime.fromisoformat(snap.get("ts", "2000-01-01"))
            if snap_time >= cutoff:
                snapshots.append(snap)
            if len(snapshots) >= limit:
                break
        except Exception:
            continue

    return snapshots


def score_node(node):
    """Score a knowledge node for relevance (recency + importance)."""
    score = 0.1  # baseline

    updated = node.get("metadata", {}).get("updatedAt")
    if updated:
        try:
            age_hours = (
                datetime.utcnow() - datetime.fromisoformat(updated)
            ).total_seconds() / 3600
            score += max(0, 1 - age_hours / 168)  # decay over 1 week
        except Exception:
            pass

    if node.get("metadata", {}).get("pinned"):
        score += 0.5

    node_type = node.get("metadata", {}).get("type", "")
    if node_type == "decision":
        score += 0.3
    elif node_type == "task":
        value = node.get("value", {})
        if isinstance(value, dict) and value.get("status") == "pending":
            score += 0.4

    return score


def select_top_entries(graph, max_tokens):
    """Select most relevant entries that fit within token budget."""
    nodes = list(graph.get("nodes", {}).values())
    scored = [(n, score_node(n)) for n in nodes]
    scored.sort(key=lambda x: x[1], reverse=True)

    selected = []
    budget = max_tokens * AVG_CHARS_PER_TOKEN  # convert to chars

    for node, _score in scored:
        text = json.dumps(node.get("value", ""))
        if len(text) > budget:
            continue
        selected.append(node)
        budget -= len(text)
        if budget <= 0:
            break

    return selected


def format_injection(entries, snapshots):
    """Format selected entries as a system-reminder compatible block."""
    lines = ["# Nexus — Restored Context from Previous Sessions", ""]

    if entries:
        # Group by type
        decisions = [e for e in entries if e.get("metadata", {}).get("type") == "decision"]
        tasks = [e for e in entries if e.get("metadata", {}).get("type") == "task"]
        changes = [e for e in entries if e.get("metadata", {}).get("type") == "code-change"]
        others = [e for e in entries if e.get("metadata", {}).get("type") not in ("decision", "task", "code-change")]

        if decisions:
            lines.append("## Key Decisions")
            for d in decisions[:10]:
                val = d.get("value", "")
                lines.append(f"- {val}")
            lines.append("")

        if tasks:
            lines.append("## Active Tasks")
            for t in tasks[:10]:
                val = t.get("value", {})
                status = val.get("status", "pending") if isinstance(val, dict) else "pending"
                text = val.get("task", str(val)) if isinstance(val, dict) else str(val)
                marker = "x" if status == "completed" else " "
                lines.append(f"- [{marker}] {text}")
            lines.append("")

        if changes:
            lines.append("## Recent Code Changes")
            for c in changes[:10]:
                val = c.get("value", {})
                if isinstance(val, dict):
                    lines.append(f"- {val.get('action', 'modified')} {val.get('file', '?')}")
                else:
                    lines.append(f"- {val}")
            lines.append("")

        if others:
            lines.append("## Other Context")
            for o in others[:5]:
                val = o.get("value", "")
                lines.append(f"- {val if isinstance(val, str) else json.dumps(val)}")
            lines.append("")

    if snapshots:
        latest = snapshots[0]
        lines.append(f"## Last Snapshot: {latest.get('id', '?')} ({latest.get('ts', '?')})")
        lines.append(f"Messages in last session: {latest.get('messageCount', '?')}")
        lines.append("")

    return "\n".join(lines)


def main():
    graph = load_knowledge_graph()
    snapshots = load_recent_snapshots()
    entries = select_top_entries(graph, MAX_INJECTION_TOKENS)

    if not entries and not snapshots:
        # Nothing to inject
        print(json.dumps({"status": "ok", "injected": 0}))
        return

    payload = format_injection(entries, snapshots)

    result = {
        "status": "ok",
        "injected": len(entries),
        "payload": payload,
    }
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()

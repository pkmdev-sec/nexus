#!/usr/bin/env python3
"""
nexus-precompact.py — PreCompact Hook

Extracts and saves context before compaction hits.
Intended to be wired as a Claude Code PreCompact hook so that
knowledge is persisted to ~/.nexus/ before the context window
is compressed.

Usage in .claude/settings.json:
  "hooks": {
    "PreCompact": [{ "command": "python3 ~/nexus/hooks/nexus-precompact.py" }]
  }
"""

import json
import os
import sys
import hashlib
from datetime import datetime
from pathlib import Path

NEXUS_DIR = Path.home() / ".nexus"
SNAPSHOTS_DIR = NEXUS_DIR / "snapshots"
KNOWLEDGE_PATH = NEXUS_DIR / "knowledge.json"


def ensure_dirs():
    NEXUS_DIR.mkdir(parents=True, exist_ok=True)
    SNAPSHOTS_DIR.mkdir(parents=True, exist_ok=True)


def read_stdin():
    """Read hook input from stdin (JSON with conversation context)."""
    try:
        raw = sys.stdin.read()
        if raw.strip():
            return json.loads(raw)
    except (json.JSONDecodeError, Exception):
        pass
    return {}


def extract_decisions(messages):
    """Pull decisions from messages."""
    import re
    patterns = [
        r"\b(?:decided|decision|chose|chosen|agreed|confirmed|going with|settled on)\b",
        r"\b(?:let'?s go with|we(?:'ll| will) use|the plan is)\b",
    ]
    decisions = []
    for msg in messages:
        content = msg.get("content", "")
        for line in content.split("\n"):
            for pat in patterns:
                if re.search(pat, line, re.IGNORECASE):
                    decisions.append({
                        "text": line.strip()[:300],
                        "speaker": msg.get("role", "unknown"),
                        "ts": datetime.utcnow().isoformat(),
                    })
                    break
    return decisions


def extract_code_changes(messages):
    """List files modified."""
    import re
    changes = []
    file_re = re.compile(r"\b([\w/.@-]+\.\w{1,6})(?::(\d+))?\b")
    action_re = re.compile(
        r"\b(created|modified|edited|wrote|updated|deleted|renamed|moved|refactored)\b",
        re.IGNORECASE,
    )
    seen = set()
    for msg in messages:
        content = msg.get("content", "")
        for line in content.split("\n"):
            files = file_re.findall(line)
            if not files:
                continue
            action_match = action_re.search(line)
            action = action_match.group(1).lower() if action_match else "touched"
            for f, _ in files:
                key = f"{f}::{action}"
                if key not in seen:
                    seen.add(key)
                    changes.append({
                        "file": f,
                        "action": action,
                        "summary": line.strip()[:200],
                    })
    return changes


def extract_tasks(messages):
    """Extract pending/completed tasks."""
    import re
    tasks = []
    for msg in messages:
        content = msg.get("content", "")
        for line in content.split("\n"):
            if re.search(r"\b(?:TODO|FIXME|task|next step|pending|blocked)\b", line, re.IGNORECASE):
                checkbox = re.match(r"\[([ x])]\s*(.*)", line, re.IGNORECASE)
                if checkbox:
                    status = "completed" if checkbox.group(1) == "x" else "pending"
                    text = checkbox.group(2).strip()
                else:
                    status = "pending"
                    text = line.strip()
                if len(text) > 5:
                    tasks.append({"task": text[:300], "status": status})
    return tasks


def create_snapshot(messages):
    """Full context snapshot."""
    ts = datetime.utcnow().isoformat()
    snap_id = hashlib.sha256(f"{ts}{len(messages)}".encode()).hexdigest()[:12]
    return {
        "id": f"snap-{snap_id}",
        "ts": ts,
        "decisions": extract_decisions(messages),
        "codeChanges": extract_code_changes(messages),
        "tasks": extract_tasks(messages),
        "messageCount": len(messages),
    }


def update_knowledge_graph(snapshot):
    """Merge snapshot into the persistent knowledge graph."""
    graph = {"nodes": {}, "meta": {}}
    if KNOWLEDGE_PATH.exists():
        try:
            graph = json.loads(KNOWLEDGE_PATH.read_text())
        except Exception:
            pass

    now = datetime.utcnow().isoformat()

    # Store decisions
    for dec in snapshot.get("decisions", []):
        key = f"decision:{hashlib.md5(dec['text'].encode()).hexdigest()[:8]}"
        graph["nodes"][key] = {
            "key": key,
            "value": dec["text"],
            "metadata": {"type": "decision", "updatedAt": now, "tags": ["decision"]},
        }

    # Store code changes
    for chg in snapshot.get("codeChanges", []):
        key = f"change:{chg['file']}:{chg['action']}"
        graph["nodes"][key] = {
            "key": key,
            "value": chg,
            "metadata": {"type": "code-change", "updatedAt": now, "tags": ["code"]},
        }

    # Store tasks
    for task in snapshot.get("tasks", []):
        key = f"task:{hashlib.md5(task['task'].encode()).hexdigest()[:8]}"
        graph["nodes"][key] = {
            "key": key,
            "value": task,
            "metadata": {"type": "task", "updatedAt": now, "tags": ["task"]},
        }

    KNOWLEDGE_PATH.write_text(json.dumps(graph, indent=2))


def main():
    ensure_dirs()

    hook_input = read_stdin()
    messages = hook_input.get("messages", [])

    if not messages:
        # If no messages provided, just create a timestamp marker
        snapshot = {
            "id": f"snap-empty-{datetime.utcnow().strftime('%Y%m%d%H%M%S')}",
            "ts": datetime.utcnow().isoformat(),
            "decisions": [],
            "codeChanges": [],
            "tasks": [],
            "messageCount": 0,
        }
    else:
        snapshot = create_snapshot(messages)

    # Save snapshot
    snap_path = SNAPSHOTS_DIR / f"{snapshot['id']}.json"
    snap_path.write_text(json.dumps(snapshot, indent=2))

    # Update knowledge graph
    update_knowledge_graph(snapshot)

    print(json.dumps({"status": "ok", "snapshot": snapshot["id"]}, indent=2))


if __name__ == "__main__":
    main()

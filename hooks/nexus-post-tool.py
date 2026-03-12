#!/usr/bin/env python3
"""
nexus-post-tool.py — PostToolUse Hook

Tracks important tool results for the knowledge graph.
Monitors file edits, important reads, and command outputs,
then stores relevant entries in ~/.nexus/knowledge.json.

Usage in .claude/settings.json:
  "hooks": {
    "PostToolUse": [{ "command": "python3 ~/nexus/hooks/nexus-post-tool.py" }]
  }
"""

import json
import hashlib
import sys
from datetime import datetime, UTC
from pathlib import Path

NEXUS_DIR = Path.home() / ".nexus"
KNOWLEDGE_PATH = NEXUS_DIR / "knowledge.json"
TOOL_LOG_PATH = NEXUS_DIR / "tool-log.jsonl"

# Tools worth tracking
TRACKED_TOOLS = {"Write", "Edit", "Bash", "NotebookEdit"}

# Max entries in tool log before rotation
MAX_LOG_ENTRIES = 500


def ensure_dirs():
    NEXUS_DIR.mkdir(parents=True, exist_ok=True)


def read_stdin():
    """Read hook input from stdin."""
    try:
        raw = sys.stdin.read()
        if raw.strip():
            return json.loads(raw)
    except Exception:
        pass
    return {}


def load_knowledge_graph():
    """Load the knowledge graph."""
    if not KNOWLEDGE_PATH.exists():
        return {"nodes": {}, "meta": {"created": datetime.now(UTC).isoformat(), "version": 1}}
    try:
        return json.loads(KNOWLEDGE_PATH.read_text())
    except Exception:
        return {"nodes": {}, "meta": {"created": datetime.now(UTC).isoformat(), "version": 1}}


def save_knowledge_graph(graph):
    """Persist the knowledge graph."""
    KNOWLEDGE_PATH.write_text(json.dumps(graph, indent=2))


def append_tool_log(entry):
    """Append to the tool activity log (JSONL)."""
    with open(TOOL_LOG_PATH, "a") as f:
        f.write(json.dumps(entry) + "\n")

    # Rotate if too large
    try:
        lines = TOOL_LOG_PATH.read_text().strip().split("\n")
        if len(lines) > MAX_LOG_ENTRIES:
            keep = lines[-MAX_LOG_ENTRIES:]
            TOOL_LOG_PATH.write_text("\n".join(keep) + "\n")
    except Exception:
        pass


def extract_file_path(tool_input):
    """Extract file path from tool input."""
    if isinstance(tool_input, dict):
        return (
            tool_input.get("file_path")
            or tool_input.get("path")
            or tool_input.get("notebook_path")
            or None
        )
    return None


def extract_command(tool_input):
    """Extract command from Bash tool input."""
    if isinstance(tool_input, dict):
        return tool_input.get("command", "")
    return ""


def process_write_edit(tool_name, tool_input, tool_output, graph):
    """Track file write/edit operations."""
    file_path = extract_file_path(tool_input)
    if not file_path:
        return

    now = datetime.now(UTC).isoformat()
    action = "created" if tool_name == "Write" else "modified"
    key = f"file-activity:{file_path}"

    graph["nodes"][key] = {
        "key": key,
        "value": {
            "file": file_path,
            "action": action,
            "tool": tool_name,
            "ts": now,
        },
        "metadata": {
            "type": "file-activity",
            "updatedAt": now,
            "tags": ["code", "file", action],
        },
    }


def process_bash(tool_input, tool_output, graph):
    """Track significant bash commands."""
    command = extract_command(tool_input)
    if not command:
        return

    # Skip trivial commands
    trivial = ["ls", "pwd", "echo", "cat", "head", "tail", "which", "whoami"]
    first_word = command.strip().split()[0] if command.strip() else ""
    if first_word in trivial:
        return

    now = datetime.now(UTC).isoformat()
    cmd_hash = hashlib.md5(command.encode()).hexdigest()[:8]
    key = f"command:{cmd_hash}"

    # Truncate output for storage
    output_str = str(tool_output)[:500] if tool_output else ""

    graph["nodes"][key] = {
        "key": key,
        "value": {
            "command": command[:300],
            "output_preview": output_str,
            "ts": now,
        },
        "metadata": {
            "type": "command",
            "updatedAt": now,
            "tags": ["bash", "command"],
        },
    }


def main():
    ensure_dirs()

    hook_input = read_stdin()
    tool_name = hook_input.get("tool_name", hook_input.get("tool", ""))
    tool_input = hook_input.get("tool_input", hook_input.get("input", {}))
    tool_output = hook_input.get("tool_output", hook_input.get("output", ""))

    if not tool_name:
        print(json.dumps({"status": "ok", "tracked": False, "reason": "no tool name"}))
        return

    # Log all tool uses
    log_entry = {
        "tool": tool_name,
        "ts": datetime.now(UTC).isoformat(),
        "input_preview": str(tool_input)[:200],
    }
    append_tool_log(log_entry)

    # Only update knowledge graph for tracked tools
    if tool_name not in TRACKED_TOOLS:
        print(json.dumps({"status": "ok", "tracked": False, "reason": "untracked tool"}))
        return

    graph = load_knowledge_graph()

    if tool_name in ("Write", "Edit", "NotebookEdit"):
        process_write_edit(tool_name, tool_input, tool_output, graph)
    elif tool_name == "Bash":
        process_bash(tool_input, tool_output, graph)

    save_knowledge_graph(graph)

    print(json.dumps({"status": "ok", "tracked": True, "tool": tool_name}))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Extract and summarize recent Claude Code sessions for the dreaming process.

Scans JSONL session files from the last N hours, extracts key information
(user messages, assistant text responses, tool usage patterns, decisions),
and outputs a structured summary suitable for memory consolidation.

Strategy: For large sessions, prioritize conversation turns (user intent +
assistant reasoning) over tool details. Subagent sessions get a condensed
summary (tools + key outputs only).

Usage:
    python3 extract-sessions.py [--hours 24] [--max-tokens 30000]
"""

import json
import sys
import time
from pathlib import Path
from typing import Any

# --- Configuration ---

CLAUDE_PROJECTS_DIR = Path.home() / ".claude" / "projects"
DEFAULT_HOURS = 24
DEFAULT_MAX_TOKENS = 30000
CHARS_PER_TOKEN = 4

# Per-message truncation limits
USER_MSG_LIMIT = 300
ASSISTANT_MSG_LIMIT = 400
# Max conversation turns per session (keeps first + last N)
MAX_TURNS_PER_SESSION = 40


def get_excluded_session_ids(exclude_triggers: list[str]) -> set[str]:
    """Get session IDs associated with specific triggers (to exclude them)."""
    if not exclude_triggers:
        return set()

    db_path = Path.home() / ".index" / "atlas.db"
    if not db_path.exists():
        return set()

    excluded = set()
    try:
        import sqlite3
        conn = sqlite3.connect(str(db_path))
        placeholders = ",".join("?" for _ in exclude_triggers)
        # Check both trigger_sessions (persistent) and session_metrics (all)
        for table, col in [("trigger_sessions", "session_id"), ("session_metrics", "session_id")]:
            try:
                rows = conn.execute(
                    f"SELECT {col} FROM {table} WHERE trigger_name IN ({placeholders})",
                    exclude_triggers,
                ).fetchall()
                excluded.update(row[0] for row in rows if row[0])
            except Exception:
                pass
        conn.close()
    except Exception:
        pass
    return excluded


def find_session_files(hours: int, exclude_triggers: list[str] | None = None) -> list[Path]:
    """Find all JSONL session files modified within the last N hours.

    Optionally excludes sessions belonging to specific triggers (e.g. 'dreaming')
    to prevent the dreaming process from analyzing its own previous runs.
    """
    cutoff = time.time() - (hours * 3600)
    excluded_ids = get_excluded_session_ids(exclude_triggers or [])
    files = []

    for project_dir in CLAUDE_PROJECTS_DIR.iterdir():
        if not project_dir.is_dir():
            continue
        for f in project_dir.glob("*.jsonl"):
            if f.stat().st_mtime >= cutoff:
                # Check if session ID is excluded
                session_id = f.stem
                if session_id in excluded_ids:
                    continue
                files.append(f)
        subagents_dir = project_dir / "subagents"
        if subagents_dir.exists():
            for f in subagents_dir.glob("*.jsonl"):
                if f.stat().st_mtime >= cutoff:
                    files.append(f)

    files.sort(key=lambda f: f.stat().st_mtime)
    return files


def extract_text(content: Any) -> str:
    """Extract plain text from message content, skipping tool results and system content."""
    if isinstance(content, str):
        if content.strip().startswith(("<system-reminder>", "<system-notice>")):
            return ""
        return content
    if isinstance(content, list):
        texts = []
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "tool_result":
                continue
            if block.get("type") == "thinking":
                # Include thinking content — it reveals reasoning and decisions
                thinking = block.get("thinking", "")
                if thinking and len(thinking) > 50:
                    texts.append(f"[thinking: {thinking[:200]}]")
                continue
            if block.get("type") == "text":
                text = block.get("text", "")
                if text.strip().startswith(("<system-reminder>", "<system-notice>")):
                    continue
                texts.append(text)
        return "\n".join(texts)
    return ""


def extract_tool_names(content: Any) -> list[str]:
    """Extract just tool names from assistant content (lightweight)."""
    if not isinstance(content, list):
        return []
    return [
        b.get("name", "?")
        for b in content
        if isinstance(b, dict) and b.get("type") == "tool_use"
    ]


def extract_tool_details(content: Any) -> list[dict]:
    """Extract tool use details (name + key params) from assistant content."""
    tools = []
    if not isinstance(content, list):
        return tools
    for block in content:
        if not isinstance(block, dict) or block.get("type") != "tool_use":
            continue
        tool = {"name": block.get("name", "?")}
        inp = block.get("input", {})
        if "command" in inp:
            tool["cmd"] = inp["command"][:150]
        if "file_path" in inp:
            tool["file"] = inp["file_path"]
        if "prompt" in inp:
            tool["prompt"] = inp["prompt"][:100]
        if "skill" in inp:
            tool["skill"] = inp["skill"]
        if "message" in inp and isinstance(inp["message"], str):
            tool["msg"] = inp["message"][:100]
        tools.append(tool)
    return tools


def is_subagent(path: Path) -> bool:
    return "subagents" in path.parts


def parse_session(path: Path) -> dict:
    """Parse a JSONL session into a structured summary with smart condensing."""
    session_id = path.stem
    sub = is_subagent(path)

    turns = []  # (role, text, tool_names)
    first_ts = last_ts = None
    tool_counts: dict[str, int] = {}
    files_touched: set[str] = set()

    try:
        with open(path) as f:
            for raw in f:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    entry = json.loads(raw)
                except json.JSONDecodeError:
                    continue

                ts = entry.get("timestamp")
                if ts:
                    if not first_ts:
                        first_ts = ts
                    last_ts = ts

                entry_type = entry.get("type")
                msg = entry.get("message", {})
                if not isinstance(msg, dict):
                    continue

                content = msg.get("content", "")

                if entry_type == "user":
                    text = extract_text(content)
                    if text and len(text.strip()) > 10:
                        turns.append(("user", text, []))

                elif entry_type == "assistant":
                    text = extract_text(content)
                    tool_names = extract_tool_names(content)
                    tool_dets = extract_tool_details(content)

                    for t in tool_dets:
                        name = t["name"]
                        tool_counts[name] = tool_counts.get(name, 0) + 1
                        if "file" in t:
                            files_touched.add(t["file"])

                    if text and len(text.strip()) > 20:
                        turns.append(("assistant", text, tool_names))
                    elif tool_names:
                        turns.append(("tools", None, tool_names))

    except Exception as e:
        return {"error": str(e), "session_id": session_id}

    # Smart truncation: keep first half and last half of turns
    if len(turns) > MAX_TURNS_PER_SESSION:
        half = MAX_TURNS_PER_SESSION // 2
        skipped = len(turns) - MAX_TURNS_PER_SESSION
        turns = turns[:half] + [("gap", f"[...{skipped} turns skipped...]", [])] + turns[-half:]

    return {
        "session_id": session_id,
        "is_subagent": sub,
        "first_ts": first_ts,
        "last_ts": last_ts,
        "turn_count": len(turns),
        "tool_counts": tool_counts,
        "files_touched": sorted(files_touched)[:20],
        "turns": turns,
    }


def format_session_full(session: dict) -> str:
    """Format a session with conversation detail (for main sessions)."""
    if "error" in session:
        return f"[Session {session['session_id'][:8]}: Error — {session['error']}]\n"
    if session["turn_count"] == 0:
        return ""

    lines = []
    sid = session["session_id"][:8]
    tag = "[subagent] " if session["is_subagent"] else ""
    lines.append(f"### {tag}Session {sid}")

    if session["first_ts"] and session["last_ts"]:
        lines.append(f"Time: {session['first_ts'][:19]} → {session['last_ts'][:19]}")

    if session["tool_counts"]:
        top = sorted(session["tool_counts"].items(), key=lambda x: -x[1])[:8]
        lines.append(f"Tools: {', '.join(f'{n}({c})' for n,c in top)}")

    if session["files_touched"]:
        lines.append(f"Files: {', '.join(session['files_touched'][:10])}")

    lines.append("")

    for role, text, tool_names in session["turns"]:
        if role == "gap":
            lines.append(text)
            continue
        if role == "user":
            t = text[:USER_MSG_LIMIT] + "..." if len(text) > USER_MSG_LIMIT else text
            # Clean up multiline for readability
            t = t.replace("\n", " ").strip()
            lines.append(f"👤 {t}")
        elif role == "assistant":
            t = text[:ASSISTANT_MSG_LIMIT] + "..." if len(text) > ASSISTANT_MSG_LIMIT else text
            t = t.replace("\n", " ").strip()
            suffix = f" [{', '.join(tool_names[:3])}]" if tool_names else ""
            lines.append(f"🤖 {t}{suffix}")
        elif role == "tools":
            lines.append(f"  🔧 {', '.join(tool_names[:5])}")

    lines.append("")
    return "\n".join(lines)


def format_session_condensed(session: dict) -> str:
    """Format a session as a brief summary (for subagent sessions)."""
    if "error" in session or session["turn_count"] == 0:
        return ""

    sid = session["session_id"][:8]
    top_tools = sorted(session["tool_counts"].items(), key=lambda x: -x[1])[:5]
    tools_str = ", ".join(f"{n}({c})" for n, c in top_tools) if top_tools else "none"

    # Get first user message as context
    first_user = ""
    for role, text, _ in session["turns"]:
        if role == "user" and text:
            first_user = text[:150].replace("\n", " ").strip()
            break

    return f"- **{sid}**: {first_user or '(no user text)'} | Tools: {tools_str}\n"


def format_session_index(session: dict, path: Path) -> str:
    """Format a session as a one-line index entry with path (for --list mode)."""
    if "error" in session or session["turn_count"] == 0:
        return ""

    sid = session["session_id"][:8]
    tag = "sub" if session["is_subagent"] else "main"
    turns = session["turn_count"]
    time_range = ""
    if session["first_ts"] and session["last_ts"]:
        time_range = f"{session['first_ts'][:19]} → {session['last_ts'][:19]}"

    top_tools = sorted(session["tool_counts"].items(), key=lambda x: -x[1])[:5]
    tools_str = ", ".join(f"{n}({c})" for n, c in top_tools) if top_tools else "none"

    # First user message as context
    first_user = ""
    for role, text, _ in session["turns"]:
        if role == "user" and text:
            first_user = text[:120].replace("\n", " ").strip()
            break

    return f"{tag} | {sid} | {turns} turns | {time_range} | {tools_str} | {first_user} | {path}\n"


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Extract recent sessions for dreaming")
    parser.add_argument("--hours", type=int, default=DEFAULT_HOURS)
    parser.add_argument("--max-tokens", type=int, default=DEFAULT_MAX_TOKENS)
    parser.add_argument("--list", action="store_true",
                        help="List session files with metadata only (no content extraction)")
    parser.add_argument("--session", type=str, default=None,
                        help="Extract a single session file (pre-processed for subagent analysis)")
    parser.add_argument("--exclude-trigger", action="append", default=[],
                        help="Exclude sessions from specific triggers (repeatable, e.g. --exclude-trigger dreaming)")
    args = parser.parse_args()

    max_chars = args.max_tokens * CHARS_PER_TOKEN

    # --session mode: extract a single session file (pre-processed for subagent)
    if args.session:
        path = Path(args.session)
        if not path.exists():
            print(f"Session file not found: {path}", file=sys.stderr)
            sys.exit(1)
        session = parse_session(path)
        if "error" in session:
            print(f"Error parsing session: {session['error']}", file=sys.stderr)
            sys.exit(1)
        print(format_session_full(session))
        sys.exit(0)

    files = find_session_files(args.hours, exclude_triggers=args.exclude_trigger)

    if not files:
        print(f"No session files found in the last {args.hours} hours.")
        sys.exit(0)

    # --list mode: lightweight index of sessions with file paths
    if args.list:
        print(f"# Sessions from last {args.hours}h ({len(files)} files)\n")
        print("type | id | turns | time | tools | context | path")
        print("--- | --- | --- | --- | --- | --- | ---")
        for f in files:
            session = parse_session(f)
            if session.get("turn_count", 0) > 0:
                line = format_session_index(session, f)
                if line:
                    print(line, end="")
        sys.exit(0)

    sessions = [parse_session(f) for f in files]
    sessions = [s for s in sessions if s.get("turn_count", 0) > 0]

    if not sessions:
        print(f"Found {len(files)} session files but none had extractable content.")
        sys.exit(0)

    main_sessions = [s for s in sessions if not s["is_subagent"]]
    sub_sessions = [s for s in sessions if s["is_subagent"]]

    # Build output with budget tracking
    parts = []
    chars = 0

    def add(text: str) -> bool:
        nonlocal chars
        if chars + len(text) > max_chars:
            return False
        parts.append(text)
        chars += len(text)
        return True

    add(f"# Session Extract — Last {args.hours}h\n")
    add(f"{len(main_sessions)} main sessions, {len(sub_sessions)} subagent sessions\n\n")

    # Main sessions — full detail
    if main_sessions:
        add("## Main Sessions\n\n")
        for session in main_sessions:
            formatted = format_session_full(session)
            if not formatted:
                continue
            if not add(formatted):
                add(f"\n[Budget reached — remaining sessions skipped]\n")
                break

    # Subagent sessions — condensed
    if sub_sessions and chars < max_chars - 2000:
        add("\n## Subagent Sessions\n\n")
        for session in sub_sessions:
            formatted = format_session_condensed(session)
            if not formatted:
                continue
            if not add(formatted):
                add(f"[...and {len(sub_sessions)} more]\n")
                break

    # Global tool usage
    all_tools: dict[str, int] = {}
    for s in sessions:
        for name, count in s.get("tool_counts", {}).items():
            all_tools[name] = all_tools.get(name, 0) + count

    if all_tools and chars < max_chars - 500:
        add("\n## Tool Usage Summary\n\n")
        for name, count in sorted(all_tools.items(), key=lambda x: -x[1])[:15]:
            add(f"- {name}: {count}\n")

    print("".join(parts))


if __name__ == "__main__":
    main()

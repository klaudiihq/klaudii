#!/usr/bin/env python3
"""
Extract readable conversation history from a Klaudii architect chat transcript.

Keeps user + assistant messages in full, summarizes tool_use as one-liners,
and omits tool_result content entirely (just notes that a result came back).

Usage:
    python3 extract-architect-history.py <path-to-1.json> [options]

Options:
    --no-tools          Omit tool_use/tool_result lines entirely
    --full-tools        Show full tool_use parameters (not just summary)
    --since TIMESTAMP   Only show messages after this Unix-ms timestamp
    --last N            Only show the last N human-readable turns (user+assistant)
    --output FILE       Write to file instead of stdout
    --markdown          Format output as Markdown (default: plain text)
"""

import json
import os
import sys
import argparse
from datetime import datetime, timezone

# Strip repo root from absolute paths in tool-call summaries
_REPO_ROOT = os.path.abspath(os.path.dirname(__file__)) + os.sep


def parse_args():
    p = argparse.ArgumentParser(description="Extract readable history from architect chat log")
    p.add_argument("file", help="Path to the conversation JSON file")
    p.add_argument("--no-tools", action="store_true", help="Omit tool_use/tool_result lines entirely")
    p.add_argument("--full-tools", action="store_true", help="Show full tool parameters")
    p.add_argument("--since", type=int, default=0, help="Only show messages after this Unix-ms timestamp")
    p.add_argument("--last", type=int, default=0, help="Only show last N user+assistant turns")
    p.add_argument("--output", "-o", type=str, default=None, help="Write to file instead of stdout")
    p.add_argument("--markdown", action="store_true", default=True, help="Markdown formatting (default)")
    p.add_argument("--plain", action="store_true", help="Plain text formatting")
    return p.parse_args()


def format_ts(ts_ms):
    """Convert Unix milliseconds to readable datetime."""
    dt = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)
    return dt.strftime("%Y-%m-%d %H:%M:%S UTC")


def summarize_tool_use(content_str):
    """Extract a one-line summary from a tool_use content JSON string."""
    try:
        data = json.loads(content_str)
        tool = data.get("tool_name", "?")
        params = data.get("parameters", {})

        # Build a short description based on tool type
        if tool == "Bash":
            cmd = params.get("command", "")
            desc = params.get("description", "")
            if desc:
                return f"[Bash] {desc}"
            return f"[Bash] {cmd[:80]}{'...' if len(cmd) > 80 else ''}"
        elif tool == "Read":
            fp = params.get("file_path", "?")
            # Shorten path
            fp = fp.replace(_REPO_ROOT, "")
            offset = params.get("offset", "")
            limit = params.get("limit", "")
            range_str = f" (lines {offset}-{offset+limit})" if offset and limit else ""
            return f"[Read] {fp}{range_str}"
        elif tool == "Write":
            fp = params.get("file_path", "?")
            fp = fp.replace(_REPO_ROOT, "")
            return f"[Write] {fp}"
        elif tool == "Edit":
            fp = params.get("file_path", "?")
            fp = fp.replace(_REPO_ROOT, "")
            return f"[Edit] {fp}"
        elif tool == "Grep":
            pat = params.get("pattern", "?")
            path = params.get("path", "")
            path = path.replace(_REPO_ROOT, "")
            return f"[Grep] pattern='{pat}' in {path or '.'}"
        elif tool == "Glob":
            pat = params.get("pattern", "?")
            return f"[Glob] {pat}"
        elif tool == "Agent":
            desc = params.get("description", "")
            sub = params.get("subagent_type", "general-purpose")
            return f"[Agent:{sub}] {desc}"
        else:
            desc = params.get("description", "")
            return f"[{tool}] {desc}" if desc else f"[{tool}]"
    except (json.JSONDecodeError, TypeError):
        return f"[tool_use] (unparseable)"


def summarize_tool_result(content_str):
    """One-line summary of a tool result."""
    try:
        data = json.loads(content_str)
        status = data.get("status", "?")
        output = data.get("output", "")
        # Truncate output preview
        preview = output[:100].replace("\n", " ")
        if len(output) > 100:
            preview += "..."
        return f"  → {status}: {preview}"
    except (json.JSONDecodeError, TypeError):
        return f"  → (result)"


def extract(messages, args):
    lines = []
    pending_tool_uses = []  # Batch consecutive tool calls

    def flush_tools():
        """Flush any batched tool_use lines."""
        nonlocal pending_tool_uses
        if pending_tool_uses and not args.no_tools:
            for t in pending_tool_uses:
                lines.append(t)
        pending_tool_uses = []

    for msg in messages:
        ts = msg.get("ts", 0)
        if ts < args.since:
            continue

        role = msg.get("role", "?")
        content = msg.get("content", "")
        time_str = format_ts(ts) if ts else ""

        if role == "user":
            flush_tools()
            sender = msg.get("sender", "user")
            if args.plain:
                lines.append(f"\n{'='*60}")
                lines.append(f"USER ({time_str}):")
                lines.append(content)
            else:
                lines.append(f"\n---\n")
                lines.append(f"**User** _{time_str}_\n")
                lines.append(content)

        elif role == "assistant":
            flush_tools()
            text = content.strip()
            if not text:
                continue
            if args.plain:
                lines.append(f"\nARCHITECT ({time_str}):")
                lines.append(text)
            else:
                lines.append(f"\n**Architect** _{time_str}_\n")
                lines.append(text)

        elif role == "tool_use":
            summary = summarize_tool_use(content)
            if args.full_tools:
                pending_tool_uses.append(f"    {summary}\n    params: {content[:300]}")
            else:
                pending_tool_uses.append(f"    {summary}")

        elif role == "tool_result":
            if not args.no_tools:
                summary = summarize_tool_result(content)
                pending_tool_uses.append(summary)

    flush_tools()
    return lines


def main():
    args = parse_args()
    if args.plain:
        args.markdown = False

    with open(args.file, "r") as f:
        messages = json.load(f)

    print(f"Loaded {len(messages)} messages", file=sys.stderr)

    # If --last N, find the last N user+assistant message boundaries
    if args.last > 0:
        # Find indices of user messages (turn boundaries)
        user_indices = [i for i, m in enumerate(messages) if m["role"] == "user"]
        if len(user_indices) > args.last:
            start_idx = user_indices[-args.last]
            messages = messages[start_idx:]
            print(f"Showing last {args.last} turns (from message index {start_idx})", file=sys.stderr)

    result = extract(messages, args)
    output = "\n".join(result)

    if args.output:
        with open(args.output, "w") as f:
            f.write(output)
        print(f"Written to {args.output}", file=sys.stderr)
    else:
        print(output)


if __name__ == "__main__":
    main()

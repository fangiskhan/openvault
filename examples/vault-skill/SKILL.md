---
name: vault
description: Query and update OpenVault — your self-hosted project hub — through the openvault MCP tools. Use when asked about a project's status, what's blocking or needs attention, recent work, the codebase, or to log a status update / handover. Answers strictly from OpenVault data, never invented.
---

# /vault — your OpenVault project hub

> Install: copy this folder to `~/.claude/skills/vault/` (so `~/.claude/skills/vault/SKILL.md` exists), then start a new Claude Code session. Requires the `openvault` MCP server connected (`claude mcp add openvault <url> --transport http --scope user`) and running.

OpenVault holds your projects' notes, status, risks, session history, and codebase maps. This skill reads and updates it through the **`openvault` MCP tools**. Always answer from the tools — never guess. If something isn't in OpenVault, say so plainly.

## Tools (from the `openvault` MCP server)

- **Read:** `list_projects`, `get_status`, `get_attention`, `get_briefing`, `search`, `read_item`
- **Write** (attributed — always pass `actor: "claude-code"`): `set_status`, `append_update`

If these tools are not available in the session, OpenVault isn't connected. Tell the user to run:

```
claude mcp add openvault http://localhost:6900/api/mcp --transport http --scope user
```

and make sure the server is running (`npm run dev` in the OpenVault repo), then start a new session.

## How to handle `/vault [request]`

**Overview / no specific project** ("/vault", "what needs attention", "status of everything"):
1. `list_projects` to see what exists.
2. `get_attention` with `scope: "all"`.
3. Summarize per project: RAG status + the top attention items, each citing its source item.

**A specific project** ("/vault Lumina", "status of website", "what's blocking X"):
1. `list_projects` or `search` to resolve the project id by name.
2. `get_briefing` and/or `get_attention` for that project.
3. Answer grounded: headline status, attention items with reasons, recent decisions/updates. Offer to `read_item` for detail.

**"What was I working on / what was the recent problem in X":**
1. Resolve the project, then `search` within it or `read_item` on its `… — overview` / session notes.
2. Summarize from the actual notes. For code questions, the `… — codebase map` note says where the source lives — read the real repo files if needed.

**Logging (write back):**
- "log to X: <text>" / "note that …" → `append_update` `{ projectId, text, actor: "claude-code" }`.
- "mark <task> blocked/done", "set <risk> mitigating" → find the item via `search`/`read_item`, then `set_status` `{ itemId, status, actor: "claude-code" }`.
- Confirm what you wrote, so the next agent/session sees it.

## Rules

- **Grounded only.** Every claim must come from a tool result. If a project or detail isn't found, say "there's nothing about X in OpenVault" — do not invent.
- Cite item titles/ids so the user can open the source.
- Keep answers tight: status first, then the few things that matter.

# Project state lives in OpenVault — read and write it via MCP

This project's status, decisions, risks, and open tasks live in **OpenVault**,
connected as the `openvault` MCP server. Use it instead of asking a human to
catch you up — and update it so the next agent doesn't need a handover.

**OpenVault project id:** `<PROJECT_ID>`  <!-- run the openvault `list_projects` tool to find it -->

## At the start of a task

- Call `get_status` and `get_attention` (with the project id above) to load the
  current state and what needs attention **before** you change anything.
- Use `get_briefing` for the full picture; `search` / `read_item` for detail.

## While you work

- When you resolve, block, or open something, call `set_status` on that
  task/risk so other agents see it immediately.

## When you finish — the handover

- Call `append_update` with `actor` set to your name (e.g. `"claude-code"`) and a
  1–3 sentence summary of what you did and what's next.
- This **replaces the human status handover**: the next agent reads your update
  instead of a person relaying it.

---

Optional, for fully hands-off handover even if the model forgets: add a `Stop`
hook in the agent repo's `.claude/settings.json` that POSTs an `append_update`
to `http://<host>/api/mcp`. The `CLAUDE.md` instruction above is usually enough
(the model writes a real summary; a hook can only send a fixed payload).

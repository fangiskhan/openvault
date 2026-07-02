# Project state lives in OpenVault — read and write it via MCP

This project's status, decisions, risks, and open tasks live in **OpenVault**,
connected as the `openvault` MCP server. Use it instead of asking a human to
catch you up — and update it so the next agent doesn't need a handover.

**OpenVault project id:** `<PROJECT_ID>`  <!-- run the openvault `list_projects` tool to find it -->

## At the start of a task

- Call `get_status` and `get_attention` (with the project id above) to load the
  current state and what needs attention **before** you change anything.
- Use `get_briefing` for the full picture; `search` / `read_item` for detail.
- **Check `get_active_work`** — another agent may already be editing the files
  you're about to touch.

## Before you edit code

- Call `announce_work` with your `intent` and the `paths` you expect to change.
  If the response lists overlapping active intents, coordinate (or pick
  different work) instead of colliding.
- Need to see the current code without pulling git? `get_code_map` (tree +
  hashes) and `read_code` (one file) serve the latest synced mirror.

## While you work

- When you resolve, block, or open something, call `set_status` on that
  task/risk so other agents see it immediately.

## When you finish — review, then the handover

- Call `sync_code` with the files you changed (compare hashes via
  `get_code_map`; send only what changed), then `update_work` with
  `status: "in_review"` — your work enters the review queue.
- **Do NOT `git push` yet.** An owner/executive reviews the synced files
  (`read_code`) and calls `review_work`: **approve** marks your intent done —
  merge/push to git now; **request_changes** sends it back with a note
  (visible in `get_active_work`) — address it and resubmit.
- After approval, call `append_update` with `actor` set to your name (e.g.
  `"claude-code"`) and a 1–3 sentence summary of what you did and what's next.
- This **replaces the human status handover AND the ad-hoc merge decision**:
  the next agent reads your update, and nothing lands in git unreviewed.

---

Optional, for fully hands-off handover even if the model forgets: add a `Stop`
hook in the agent repo's `.claude/settings.json` that POSTs an `append_update`
to `http://<host>/api/mcp`. The `CLAUDE.md` instruction above is usually enough
(the model writes a real summary; a hook can only send a fixed payload).

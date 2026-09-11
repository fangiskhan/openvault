<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Project knowledge lives in OpenVault

This repository is OpenVault itself. Its status, decisions, risks, open tasks,
shared code mirror and active work live in the vault, reached through the
`openvault` MCP server. Read it instead of asking a human to catch you up, and
write to it so the next agent needs no handover. Tool names appear to you as
`mcp__openvault__<tool>`. The set you can see is fixed by the `enabled_tools`
allowlist in your MCP config; if a tool named below is missing, say so rather
than pretending to have used it.

Before asking about any past project, decision, codebase detail, or "what did
we do about X", search the vault first. If it has no record, say so plainly
rather than guessing, and only then ask.

## At the start of a task

1. `list_projects`, then take the **id** of the project named `OpenVault`.
   `get_briefing` accepts a project name and answers with an empty-scope
   briefing that looks correct (`itemsConsidered: 0`), so always pass the id.
2. `get_briefing {projectId}` and `get_recent_activity {projectId}` for the
   current state and what changed since yesterday.
3. `list_skills {projectId}` and follow the ones that apply. They are this
   team's conventions, not suggestions; `get_skill` has the full text.
4. `get_active_work {projectId}`: another agent may already be editing the
   files you are about to touch.

## Before you edit code

- `announce_work` with your `intent` and the `paths` you expect to change. If
  the reply lists overlapping active intents, coordinate or pick different
  work instead of colliding.
- Need current code without pulling git? `get_code_map` gives the tree with
  hashes, `read_code` one file, `search_code` a grep over the mirror. For more
  than a file or two, `scripts/checkout-mirror.ts` materialises the mirror
  locally.
- `list_suggestions {projectId}`: open proposals may already cover what you
  are about to do.

## Finding things

- `search {query, scope: "all"}` for anything by keyword, across every
  project. `"Quoted"` queries stay literal.
- `read_item {itemId}` for the full note behind a hit.
- `list_files` and `read_file` for uploaded documents; `read_file` returns an
  image as an image.

## Write back what the next session would otherwise rediscover

Do this on your own, without being asked, before you finish.

- `append_update {projectId, text}` for a one-line progress log or handover.
- `import_notes {projectName, notes: [{title, body}]}` for atomic notes.

What earns a note: a decision and its reasoning, including what was rejected;
a gotcha with its symptom, cause and fix; how a subsystem works once you have
read it; measured numbers rather than adjectives; and anything the owner
corrected you about. The correction is the durable fact.

How to write it: one idea per note; a specific, searchable title, never
"Notes 3"; `[[Exact Note Title]]` links between related notes; bodies that
stand alone; `search` first and update an existing note rather than adding a
near-duplicate. Facts from source code beat facts from memory. When they
disagree, read the code, fix the note, and say so.

## Changing code you cannot push yourself

If you have no git access here, or the mirror is a replica (`sync_code` will
refuse you and say so), your deliverable is a `suggest_change` proposal:
content-anchored edits, the exact text to replace and what it becomes, with a
required `reason`. Not a note describing the fix, not prose telling the owner
what to run. Work the owner has to reconstruct from prose is undelivered.

## Verifying this repository

- `npm run check` runs the typecheck, the linter and the test suite. CI runs
  the same command on every push.
- The dev server is `npm run dev` on port 6900. On Windows it holds a lock on
  the Prisma engine, so `prisma generate` and `next build` fail until it is
  stopped.
- Never print, log or commit a bearer token. Load it from the environment.

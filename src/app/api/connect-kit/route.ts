import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { badRequest } from "@/lib/http";

// GET /api/connect-kit?projectId=X&file=claude|hooks
// Downloadable starter files with the server URL and project id BAKED IN, so
// connecting a repo to its OpenVault project is: drop two files, done.
//  - file=claude → CLAUDE.md section teaching the daily loop (read on start,
//    announce before editing, sync + in_review when done, handover)
//  - file=hooks  → .claude/settings.json snippet whose SessionStart hook curls
//    the plain-text briefing, so every session starts pre-briefed automatically.
export async function GET(req: Request) {
  const denied = await requireAuth();
  if (denied) return denied;

  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId") ?? "";
  const file = url.searchParams.get("file") ?? "claude";
  const base = `${url.protocol}//${url.host}`;

  // Vault-wide global CLAUDE.md: the "consult the vault before asking your
  // human" standing orders, for ~/.claude/CLAUDE.md so EVERY session on the
  // user's machine gets them — any folder, any project. A download, never an
  // auto-write: a server that could silently edit a connecting user's files
  // would be a prompt-injection hole, so placing it stays the human's choice.
  if (file === "global-claude") {
    const projects = await prisma.project.findMany({ orderBy: { name: "asc" }, select: { name: true } });
    const names = projects.map((p) => p.name).join(", ") || "(none yet)";
    const md = `# Project knowledge lives in OpenVault

The \`openvault\` MCP server (${base}/api/mcp) is my source of truth for all my
projects: ${names} — plus decisions, status, session history, and code mirrors.

**Before asking me about any past project, decision, codebase detail, or "what
did we do about X" — search the vault first:**

- \`search {query, scope: "all"}\` for anything by keyword
- \`get_briefing {projectId}\` for a project's current state
- \`read_item {itemId}\` for the full note behind a search hit
- \`get_code_map\` / \`read_code\` for the actual code in a project's mirror

If the vault has no record, say so plainly rather than guessing, and only then
ask me. When you learn something new and durable about a project during our
conversation, write it back (\`append_update\`, or \`import_notes\` for bigger
chunks) so the next session finds it.

Not connected? \`claude mcp add openvault ${base}/api/mcp --transport http --scope user\`
(add \`--header "Authorization: Bearer <ovk_ token>"\` when the server requires auth).
`;
    return new Response(md, {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="CLAUDE.md"`,
      },
    });
  }

  // The ingest skill is vault-wide (it discovers projects itself) — no projectId.
  if (file === "ingest-skill") {
    const skill = `---
name: vault-ingest
description: Ingest a conversation, transcript, document, or database export into OpenVault as linked atomic notes. Use when asked to "ingest this into the vault", "import this doc", "upload this database", or to turn raw content into organized notes.
---

# /vault-ingest — turn raw content into a linked knowledge graph

> Install: save this file as \`~/.claude/skills/vault-ingest/SKILL.md\`, then start a new session.
> Requires the \`openvault\` MCP server connected (${base}/api/mcp).

OpenVault stores knowledge as atomic, wikilinked notes. The server builds the
graph (links, backlinks, related-note inference, topic clusters) on its own;
YOUR job is the judgment: splitting raw content into good notes.

## How to ingest

1. **Read the source** (conversation, transcript, doc, DB export, spreadsheet).
2. **Split it into atomic notes.** One idea, decision, problem, or chapter per
   note. Aim for 5-40 notes per source. Each note gets:
   - A specific, searchable title ("Auth token hashing decision", never "Notes 3")
   - A markdown body that stands alone (a reader lands here without context)
   - \`[[wikilinks]]\` to other note titles wherever ideas touch
   - A type: note | meeting | task | risk (tasks/risks feed the status board)
3. **Call the \`import_notes\` MCP tool** with the batch:
   - \`projectName\`: an existing project or a new name (it creates the project)
   - \`notes\`: your atomic notes
   - \`mocTitle\`: "<Source> — Map of Content" (recommended; becomes the index)
   - \`connectTo\`: related project names, so links and search cross over
   - Max 1000 notes per call; batch larger sources.
   - Never set \`replace\` unless the user asks to overwrite (owner/executive only).
4. **Verify**: call \`get_graph\` on the project; if notes came out isolated
   (degree 0), add wikilinks and re-import those notes, or use \`suggest_links\`
   to find what they should point at.
5. **Report**: tell the user the project, note count, and the MOC title.

## Rules

- Split by meaning, never by length. A 3-line decision beats a 3-page dump.
- Preserve the source's facts; do not summarize away specifics (names, numbers,
  commands, errors).
- Reuse existing note titles in wikilinks when the vault already covers a
  topic (\`search\` first) — the graph self-heals ghost links by title.
`;
    return new Response(skill, {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="SKILL.md"`,
      },
    });
  }

  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, name: true } });
  if (!project) return badRequest("unknown projectId");

  if (file === "hooks") {
    const hooks = {
      hooks: {
        SessionStart: [
          {
            matcher: "startup",
            hooks: [
              {
                type: "command",
                // Plain-text endpoint: no JSON escaping, same command on
                // Windows (curl.exe) and unix. Add
                //   -H "Authorization: Bearer <your ovk_ token>"
                // when the server requires auth (production).
                command: `curl -s ${base}/api/brief/${project.id}`,
              },
            ],
          },
        ],
      },
    };
    return new Response(JSON.stringify(hooks, null, 2), {
      headers: {
        "content-type": "application/json",
        "content-disposition": `attachment; filename="openvault-hooks.settings.json"`,
      },
    });
  }

  if (file === "commit-hook") {
    const hook = `#!/usr/bin/env node
// OpenVault post-commit hook — auto-syncs each commit's changed files into the
// project's code mirror, so other agents always browse current code with no one
// remembering to sync. Install: save as .git/hooks/post-commit (no extension)
// and make it executable (chmod +x on unix). Set OPENVAULT_TOKEN in your env
// when the server requires auth. Generated for project "${project.name}".
const { execSync } = require("node:child_process");
const { readFileSync } = require("node:fs");

const VAULT = "${base}";
const PROJECT_ID = "${project.id}";
const MAX_CHARS = 200000;

function sh(cmd) { return execSync(cmd, { encoding: "utf8" }).trim(); }

async function main() {
  const status = sh("git diff-tree --no-commit-id --name-status -r HEAD");
  if (!status) return;
  const ref = sh("git rev-parse --abbrev-ref HEAD") + " @ " + sh("git rev-parse --short HEAD");
  const files = [];
  const deletes = [];
  for (const line of status.split("\\n")) {
    const [flag, ...rest] = line.split("\\t");
    const path = rest[rest.length - 1];
    if (!path) continue;
    if (flag === "D") { deletes.push(path); continue; }
    try {
      const content = readFileSync(path, "utf8");
      if (content.length <= MAX_CHARS && !content.includes("\\u0000")) files.push({ path, content });
    } catch { /* binary or unreadable — skip */ }
  }
  if (!files.length && !deletes.length) return;

  const headers = { "content-type": "application/json" };
  if (process.env.OPENVAULT_TOKEN) headers.authorization = "Bearer " + process.env.OPENVAULT_TOKEN;
  const res = await fetch(VAULT + "/api/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "sync_code", arguments: { projectId: PROJECT_ID, ref, files: files.slice(0, 100), deletes, actor: "post-commit-hook" } },
    }),
  });
  console.log(res.ok
    ? "openvault: mirror synced (" + files.length + " file(s), " + deletes.length + " delete(s), " + ref + ")"
    : "openvault: sync failed (HTTP " + res.status + ") — mirror may be stale");
}

main().catch((e) => console.log("openvault: sync skipped — " + e.message));
`;
    return new Response(hook, {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "content-disposition": `attachment; filename="post-commit"`,
      },
    });
  }

  const claude = `# Project state lives in OpenVault — read and write it via MCP

This project's status, decisions, risks, open tasks, shared code mirror, and
active work all live in **OpenVault** (${base}), connected as the \`openvault\`
MCP server. Use it instead of asking a human to catch you up — and update it so
the next agent doesn't need a handover.

**OpenVault project:** ${project.name}
**OpenVault project id:** \`${project.id}\`

Not connected? \`claude mcp add openvault ${base}/api/mcp --transport http --scope user\`
(add \`--header "Authorization: Bearer <your ovk_ token>"\` if the server requires auth).

## At the start of a task

- If a session-start hook already injected the briefing, read it. Otherwise call
  \`get_briefing\` and \`get_recent_activity\` (projectId above) to load current
  state and what changed since yesterday.
- **Check \`get_active_work\`** — another agent may already be editing the files
  you're about to touch.

## Before you edit code

- Call \`announce_work\` with your \`intent\` and the \`paths\` you expect to
  change. If the response lists overlapping active intents, coordinate (or pick
  different work) instead of colliding.
- Need current code without pulling git? \`get_code_map\` (tree + hashes) and
  \`read_code\` (one file) serve the latest synced mirror.

## When you finish — review, then the handover

- \`sync_code\` the files you changed (diff hashes via \`get_code_map\`; send
  only what changed), then \`update_work\` with \`status: "in_review"\`.
- **Do NOT \`git push\` yet.** An owner/executive reviews the synced files and
  calls \`review_work\` — approve means merge/push now; request_changes comes
  back with a note in \`get_active_work\`. Address it and resubmit.
- After approval: \`append_update\` (actor = your name, e.g. "claude-code") with
  a 1–3 sentence summary of what you did and what's next.
`;

  return new Response(claude, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="CLAUDE.md"`,
    },
  });
}

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
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, name: true } });
  if (!project) return badRequest("unknown projectId");

  const base = `${url.protocol}//${url.host}`;

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

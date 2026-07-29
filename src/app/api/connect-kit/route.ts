import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { toSkillMarkdown } from "@/lib/skills";
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
ask me.

## Write back what the next session would otherwise have to rediscover

Do this on your own, without being asked. Use \`import_notes\` for a batch of
atomic notes, \`append_update\` for a one-line progress log.

What earns a note: a decision **and its reasoning** (including what was
rejected); a gotcha with its symptom, cause and fix; how a subsystem actually
works once you have read it; measured numbers rather than adjectives; and
anything I corrected you about — my correction is the durable fact, your first
answer was not.

How to write it: one idea per note; specific searchable titles ("Auth token
hashing decision", never "Notes 3"); link related notes with
\`[[Exact Note Title]]\`; bodies that stand alone; \`search\` first and update an
existing note rather than adding a near-duplicate. Facts from source code beat
facts from memory — when they disagree, read the code, fix the note, and say so.

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

  // One of the project's own skills, as a SKILL.md for ~/.claude/skills/<name>/.
  // Optional: agents already get these in-session via list_skills / get_skill.
  if (file === "project-skill") {
    const name = (url.searchParams.get("name") ?? "").trim().toLowerCase();
    const skill = await prisma.projectSkill.findUnique({ where: { projectId_name: { projectId, name } } });
    if (!skill) return badRequest("unknown skill");
    return new Response(toSkillMarkdown(skill), {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="SKILL.md"`,
      },
    });
  }

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
        // Automatic capture: records WHICH files a session touched, so the
        // vault has a factual trail even when an agent forgets to write a
        // handover. It posts filenames and tool names only — never file
        // contents or command output — and fails silently so a vault that is
        // down can never interrupt anyone's work.
        //
        // This runs a script rather than a bare curl because Claude Code
        // delivers the tool call as JSON on STDIN. There are no $CLAUDE_TOOL_*
        // environment variables (the documented set is CLAUDE_PROJECT_DIR,
        // CLAUDE_PLUGIN_*, CLAUDE_CODE_*, CLAUDE_EFFORT), so a curl that
        // interpolates them sends empty strings and records nothing — silently,
        // because the server still answers 200. Download the companion script
        // from ?file=activity-script and save it next to this settings file.
        PostToolUse: [
          {
            matcher: "Edit|Write|NotebookEdit",
            hooks: [
              {
                type: "command",
                command: `node "$CLAUDE_PROJECT_DIR/.claude/openvault-activity.mjs"`,
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

  // The companion to the PostToolUse hook above. Save as
  // .claude/openvault-activity.mjs in the repo.
  if (file === "activity-script") {
    const js = `// Records which file a Claude Code session just touched, for this project's
// OpenVault activity trail. Filenames and tool names only — never file
// contents, never command output.
//
// This is a script, not a curl one-liner, for one reason: a PostToolUse hook
// receives the tool call as JSON on STDIN. Claude Code exposes no
// $CLAUDE_TOOL_NAME or $CLAUDE_TOOL_FILE_PATH — the documented environment is
// CLAUDE_PROJECT_DIR, CLAUDE_PLUGIN_*, CLAUDE_CODE_* and CLAUDE_EFFORT. A hook
// that interpolates the former posts empty strings and records nothing, and
// because the server still answers 200 nobody ever finds out.
//
// Set OPENVAULT_TOKEN to your ovk_ account token when the vault requires auth
// (any deployment with secrets configured); without it the POST is rejected.
import { relative, isAbsolute } from "node:path";

const VAULT = "${base}";
const PROJECT_ID = "${project.id}";
const TOKEN = (process.env.OPENVAULT_TOKEN ?? "").replace(/^\\uFEFF/, "").trim();

async function readStdin() {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

async function main() {
  const payload = JSON.parse((await readStdin()) || "{}");
  const input = payload.tool_input ?? {};
  // NotebookEdit carries notebook_path; Edit and Write use file_path.
  const raw = input.file_path ?? input.notebook_path ?? "";
  if (!raw) return;

  // Store repo-relative paths. An absolute path would pin one laptop's
  // directory layout into a shared vault, and would not line up with the code
  // mirror, whose paths come from \`git ls-files\`.
  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const file = (isAbsolute(raw) ? relative(root, raw) : raw).replace(/\\\\/g, "/");
  if (!file || file.startsWith("../")) return; // outside the repo — not ours to record

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 2000);
  try {
    await fetch(VAULT + "/api/activity", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(TOKEN ? { authorization: "Bearer " + TOKEN } : {}),
      },
      body: JSON.stringify({ projectId: PROJECT_ID, tool: payload.tool_name, file }),
      signal: ctl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

main().catch((err) => {
  // Always exits 0: a vault that is down, slow, or unreachable must never
  // interrupt anyone's work. But a connection failure is the ONLY thing worth
  // swallowing in silence — anything else is a bug in this hook, and the whole
  // point of rewriting it was that the old one failed without a trace.
  const offline = err?.name === "AbortError" || Boolean(err?.cause?.code ?? err?.code);
  if (!offline) console.error("openvault activity hook: " + (err?.message ?? err));
});
`;
    return new Response(js, {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "content-disposition": `attachment; filename="openvault-activity.mjs"`,
      },
    });
  }

  // The CI authority. A local post-commit hook only fires on the machine that
  // made the commit, and only for that person's commits, which is how a mirror
  // ends up as per-file last-write-wins soup spanning several refs — a tree
  // that never existed in the repo. This runs once per push to the default
  // branch and syncs the WHOLE tree plus deletions, so the mirror equals one
  // commit. It replaces the post-commit hook; do not run both.
  if (file === "gh-action") {
    const yml = `# Keeps this project's OpenVault code mirror equal to the default branch.
#
# Setup:
#   1. Create a CI account in OpenVault (Accounts -> Add a member, e.g. "ci"),
#      approve it, and copy its one-time ovk_ token.
#   2. Add that token as a repository secret named OPENVAULT_TOKEN:
#        gh secret set OPENVAULT_TOKEN --body "ovk_..."
#      Use --body, not a pipe: piping on Windows PowerShell writes a UTF-8 BOM
#      into the secret, and the run then fails on a header-encoding error.
#   3. Have an owner run set_mirror_mode { projectId, mode: "replica",
#      writer: "ci" } so nothing but this workflow can write the mirror.
#   4. Commit this file to .github/workflows/openvault-sync.yml
#
# After that the mirror is a read-only replica of one commit. Agents read it
# with get_code_map / read_code; code changes go through pull requests.
name: Sync code mirror to OpenVault

on:
  push:
    branches: [main, master]
  workflow_dispatch:

concurrency:
  # Never let two pushes interleave batches — that is how a mirror ends up
  # holding half of one commit and half of another.
  group: openvault-mirror
  cancel-in-progress: false

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Push tree to OpenVault
        env:
          OPENVAULT_URL: ${base}
          OPENVAULT_PROJECT: ${project.id}
          OPENVAULT_TOKEN: \${{ secrets.OPENVAULT_TOKEN }}
        run: node .github/workflows/openvault-sync.mjs
`;
    return new Response(yml, {
      headers: {
        "content-type": "text/yaml; charset=utf-8",
        "content-disposition": `attachment; filename="openvault-sync.yml"`,
      },
    });
  }

  if (file === "gh-action-script") {
    const js = `// Syncs the checked-out tree to an OpenVault code mirror. Run by
// .github/workflows/openvault-sync.yml on every push to the default branch.
//
// Whole-tree, not changed-files-only: a mirror built from per-commit deltas
// drifts into a mix of refs that never existed together. Sending the full
// manifest each time means the mirror is always exactly this commit, and files
// deleted in the repo are deleted here too.
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// Strip a BOM and surrounding whitespace. Setting a secret by piping a string
// on Windows PowerShell prepends U+FEFF, which makes the Authorization header
// throw "Cannot convert argument to a ByteString" — an error that names an
// index in an internal string and says nothing about the real cause.
const clean = (v) => (v ?? "").replace(/^\\uFEFF/, "").trim();
const VAULT = clean(process.env.OPENVAULT_URL);
const PROJECT = clean(process.env.OPENVAULT_PROJECT);
const TOKEN = clean(process.env.OPENVAULT_TOKEN);
if (!VAULT || !PROJECT || !TOKEN) {
  console.error("Missing OPENVAULT_URL / OPENVAULT_PROJECT / OPENVAULT_TOKEN");
  process.exit(1);
}

const MAX_CHARS = 4_000_000;
const BATCH_FILES = 100;
const BATCH_BYTES = 1_800_000;
const TEXT = /\\.(ts|tsx|js|jsx|mjs|cjs|json|md|txt|css|scss|html|yml|yaml|toml|py|rb|go|rs|java|kt|swift|sh|sql|prisma|graphql)$/i;

const call = async (name, args) => {
  const res = await fetch(VAULT + "/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + TOKEN },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  if (!res.ok) throw new Error("HTTP " + res.status + " " + (await res.text()).slice(0, 300));
  const json = await res.json();
  const text = json.result?.content?.[0]?.text ?? "{}";
  if (json.result?.isError) throw new Error(text);
  return JSON.parse(text);
};

const sh = (cmd) => execSync(cmd, { encoding: "utf8" }).trim();
const ref = sh("git rev-parse --abbrev-ref HEAD") + " @ " + sh("git rev-parse --short HEAD");

const paths = sh("git ls-files").split("\\n").map((p) => p.trim()).filter((p) => p && TEXT.test(p));
const files = [];
for (const p of paths) {
  try {
    const content = readFileSync(p, "utf8");
    if (content.length <= MAX_CHARS && !content.includes("\\u0000")) files.push({ path: p, content });
  } catch { /* unreadable — skip */ }
}

// Skip files the mirror already holds byte-identically.
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const map = await call("get_code_map", { projectId: PROJECT });
const known = new Map((map.files ?? []).map((f) => [f.path, f.hash]));
const changed = files.filter((f) => known.get(f.path) !== sha256(f.content));

const batches = [];
let cur = [];
let bytes = 0;
for (const f of changed) {
  const cost = f.content.length + f.path.length + 32;
  if (cur.length && (cur.length >= BATCH_FILES || bytes + cost > BATCH_BYTES)) { batches.push(cur); cur = []; bytes = 0; }
  cur.push(f);
  bytes += cost;
}
if (cur.length) batches.push(cur);

let synced = 0;
for (let i = 0; i < batches.length; i++) {
  const r = await call("sync_code", { projectId: PROJECT, ref, files: batches[i], actor: "ci" });
  synced += r.synced ?? 0;
  console.log("batch " + (i + 1) + "/" + batches.length + ": " + (r.synced ?? 0) + " file(s)");
}

// The manifest is the whole commit. Anything mirrored but missing from it was
// deleted in this commit, so it is removed — and the project is recorded as
// sitting at this ref, which is what staleness warnings compare against.
const done = await call("sync_code", { projectId: PROJECT, ref, files: [], manifest: files.map((f) => f.path), actor: "ci" });
console.log("mirror now at " + ref + ": " + files.length + " file(s), " + synced + " updated, " + (done.pruned ?? 0) + " removed");
`;
    return new Response(js, {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "content-disposition": `attachment; filename="openvault-sync.mjs"`,
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
  const call = async (name, args) => {
    const res = await fetch(VAULT + "/api/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const json = await res.json();
    return JSON.parse(json.result?.content?.[0]?.text ?? "{}");
  };

  // Tell the server what we believe each file currently is. Without this the
  // hook pushes blind and can replace work that exists ONLY in the mirror —
  // which has happened, silently, and cost a day's work. With it, a clashing
  // file is refused and reported instead of overwritten.
  let baseHashes = new Map();
  try {
    const map = await call("get_code_map", { projectId: PROJECT_ID });
    baseHashes = new Map((map.files ?? []).map((f) => [f.path, f.hash]));
  } catch { /* first sync, or vault unreachable — fall through */ }
  for (const f of files) {
    const known = baseHashes.get(f.path);
    if (known) f.baseHash = known;
  }

  const r = await call("sync_code", {
    projectId: PROJECT_ID, ref, files: files.slice(0, 100), deletes, actor: "post-commit-hook",
  });
  console.log("openvault: mirror synced (" + (r.synced ?? 0) + " file(s), " + (r.deleted ?? 0) + " delete(s), " + ref + ")");
  if (r.conflicts?.length) {
    console.log("openvault: " + r.conflicts.length + " file(s) NOT synced — changed in the mirror since you last read them:");
    for (const c of r.conflicts) {
      console.log("  " + c.path + " (currently " + (c.currentSyncedBy || "unknown") + (c.currentRef ? ", ref " + c.currentRef : "") + ")");
    }
    console.log("  Your commit is safe in git. Nothing in the mirror was lost. Merge those paths and re-sync.");
  }
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
- **Call \`list_skills\` for this project and follow the ones that apply.** They
  are this team's conventions — how the tests are run, what the review checks,
  which traps to avoid — and they are rules, not suggestions. \`get_skill\` has
  the full instructions. When you learn how this project wants something done,
  record it with \`set_skill\` so the next agent inherits it.
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

## Write back what the next session would otherwise have to rediscover

A vault is only worth what gets written into it. Whenever this conversation
produces knowledge that outlives it, record it with \`import_notes\` (a batch of
atomic notes) or \`append_update\` (a short log line). Do this without being
asked — the user should never have to say "save that".

What earns a note:

- **A decision and its reasoning.** Not just what was chosen, but why, and what
  was rejected. "Templated briefing, no server-side LLM, because every user
  already brings a model" beats "briefing is templated".
- **A gotcha you hit.** The symptom, the cause, the fix. These are the most
  expensive things to rediscover.
- **How a subsystem actually works**, once you have read it.
- **Measured numbers**, never adjectives. "6,010 tokens vs 83,106" beats "much
  cheaper".
- **Anything the user corrected you about.** Their correction is the durable
  fact; your first answer was not.

How to write it:

- One idea per note. Titles must be specific and searchable ("Auth token
  hashing decision"), never generic ("Notes 3").
- Link related notes with \`[[Exact Note Title]]\` so the graph connects.
- Bodies stand alone: someone landing on this note has no other context.
- Prefer updating an existing note over adding a near-duplicate — \`search\`
  first.
- Facts from source code beat facts from memory. When they disagree, read the
  code, fix the note, and say so.
`;

  return new Response(claude, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="CLAUDE.md"`,
    },
  });
}

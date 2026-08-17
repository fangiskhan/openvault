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

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true, slug: true },
  });
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
            // All four SessionStart sources, not just "startup": the matcher is
            // tested against the source Claude Code reports, and a bare
            // "startup" silently skips every resumed, cleared and post-compact
            // session — measured, not assumed (`claude -c` reports
            // source=resume and a "startup" matcher does not fire). Those are
            // exactly the sessions that most need a briefing: after a compact
            // the model has just lost the context this would restore.
            matcher: "startup|resume|clear|compact",
            hooks: [
              {
                type: "command",
                // A script, not the `curl -s` this used to be. That one-liner
                // had no Authorization header (so a deployed vault answered 401)
                // and -s printed nothing when it failed, so a session that got
                // no briefing was indistinguishable from one that needed none.
                // A matcher bug that skipped every resumed session hid behind
                // exactly that silence for six weeks. Download the companion
                // script from ?file=brief-script and save it alongside.
                command: `node "$CLAUDE_PROJECT_DIR/.claude/openvault-brief.mjs"`,
                timeout: 15,
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
        // A scheduled decision moment for writing back. Capture is otherwise
        // pure discipline — an instructions block ASKS the agent to record what
        // it learned, and a model that ignores prose leaves the vault empty.
        // This borrows Hermes Agent's background-review idea onto a Stop hook:
        // the runtime schedules the moment, the model still makes the call.
        // Silent when the session already wrote back, silent below its
        // thresholds, and silent on any error. Download ?file=nudge-script.
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: `node "$CLAUDE_PROJECT_DIR/.claude/openvault-nudge.mjs"`,
                timeout: 10,
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

  // The companion to the SessionStart hook above. Save as
  // .claude/openvault-brief.mjs in the repo. This is the SAME file this repo
  // ships in its own .claude/ — the vault hands out what it runs itself.
  if (file === "brief-script") {
    const js = `// Prints this project's OpenVault briefing at the start of a Claude Code
// session. The hook's stdout becomes session context, so the agent begins
// already knowing the project's state — no tool calls, no tokens spent asking.
//
// This is a script rather than the \`curl -s\` one-liner it replaces, for two
// reasons that cost six weeks between them:
//
//   1. AUTH. A deployed vault requires a bearer token. A hook COMMAND string is
//      not a guaranteed place to expand $OPENVAULT_TOKEN (it is not expanded the
//      same way on every shell and platform), so the token is read here in Node,
//      where it always works.
//   2. VISIBILITY. \`curl -s\` prints nothing when it fails. A session that got no
//      briefing looked exactly like a session for which none existed, so a
//      matcher bug that skipped every resumed session went unnoticed for six
//      weeks. This says one short line on stderr instead of failing invisibly.
//
// The project is addressed by SLUG, not by id, so this file works unchanged in
// anyone's clone. Override either value if your vault is elsewhere:
//   OPENVAULT_URL     default http://localhost:6900
//   OPENVAULT_PROJECT default openvault
//   OPENVAULT_TOKEN   an ovk_ account token; only needed when the vault has
//                     secrets configured (any real deployment)

const VAULT = (process.env.OPENVAULT_URL ?? "${base}").replace(/\\/+$/, "");
const PROJECT = process.env.OPENVAULT_PROJECT ?? "${project.slug}";
// Strip a BOM: a token piped into an env var on Windows PowerShell carries one,
// and it lands in the Authorization header as an unencodable character.
const TOKEN = (process.env.OPENVAULT_TOKEN ?? "").replace(/^﻿/, "").trim();

// 10s, not the 2s the activity hook uses: this runs against a Next dev server
// that compiles the route on first hit. Measured cold: >3s. Warm: ~20ms. A hook
// that gives up during the first compile of the day reports a live vault as
// unreachable — which is the exact class of lie this script exists to stop.
const ctl = new AbortController();
const timer = setTimeout(() => ctl.abort(), 10_000);

try {
  const res = await fetch(\`\${VAULT}/api/brief/\${encodeURIComponent(PROJECT)}\`, {
    headers: TOKEN ? { authorization: \`Bearer \${TOKEN}\` } : {},
    signal: ctl.signal,
  });
  if (res.ok) {
    process.stdout.write(await res.text());
  } else if (res.status === 401) {
    // The one failure with an action attached, so it names the action.
    console.error(\`openvault brief: 401 from \${VAULT} — set OPENVAULT_TOKEN to an ovk_ token for this vault.\`);
  } else if (res.status === 404) {
    console.error(\`openvault brief: no project '\${PROJECT}' in \${VAULT} — set OPENVAULT_PROJECT to its slug.\`);
  } else {
    console.error(\`openvault brief: \${VAULT} answered HTTP \${res.status}.\`);
  }
} catch (err) {
  // A vault that is off is the NORMAL case for someone who cloned this repo and
  // has not started one, so this stays a single quiet line rather than a stack.
  const offline = err?.name === "AbortError" || Boolean(err?.cause?.code ?? err?.code);
  console.error(
    offline
      ? \`openvault brief: no vault reachable at \${VAULT} (skipping). Run 'npm run dev' here, or unset this hook.\`
      : \`openvault brief: \${err?.message ?? err}\`,
  );
} finally {
  clearTimeout(timer);
}

// ALWAYS exit 0. A briefing is a convenience; it must never block a session.
process.exit(0);
`;
    return new Response(js, {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "content-disposition": `attachment; filename="openvault-brief.mjs"`,
      },
    });
  }

  // The companion to the Stop hook above. Save as
  // .claude/openvault-nudge.mjs in the repo. Same file this repo runs itself.
  if (file === "nudge-script") {
    const js = `// A scheduled decision moment for writing back to OpenVault.
//
// The problem this solves: every note in a vault exists because an agent CHOSE
// to write it, and the only thing asking is prose in an instructions block. That
// makes capture a matter of discipline, and discipline is not a mechanism — a
// less compliant model writes nothing and the vault quietly stays empty.
//
// Borrowed from Hermes Agent (NousResearch/hermes-agent v0.20.3), which forks a
// background review agent every N turns and hands it a fixed prompt asking
// whether anything is worth saving. The decision stays the model's; the runtime
// only schedules the MOMENT. This is that idea on a Stop hook.
//
// It is deliberately quiet:
//   - silent if the session already wrote to the vault (never nag someone who
//     did the right thing — this gate is what keeps a disciplined session at
//     zero interruptions)
//   - silent below the thresholds
//   - silent when re-entered from its own nudge (stop_hook_active)
//   - silent on any error at all
//
// Tuning, all optional:
//   OPENVAULT_NUDGE=0        turn it off entirely
//   OPENVAULT_NUDGE_EDITS    file edits before a checkpoint  (default 6)
//   OPENVAULT_NUDGE_TURNS    assistant turns before one      (default 14)
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const EDITS = Number(process.env.OPENVAULT_NUDGE_EDITS ?? 6);
const TURNS = Number(process.env.OPENVAULT_NUDGE_TURNS ?? 14);

// Tools that mean "this session already recorded something durable".
const WROTE_BACK = /^mcp__openvault__(import_notes|append_update|set_status|suggest_change|flag_issue|announce_work|update_work|upload_file)$/;
// Tools that mean "real work happened that might be worth recording".
const DID_WORK = /^(Edit|Write|MultiEdit|NotebookEdit)$/;

async function readStdin() {
  let d = "";
  process.stdin.setEncoding("utf8");
  for await (const c of process.stdin) d += c;
  return d;
}

function statePath(sessionId) {
  const dir = join(tmpdir(), "openvault-nudge");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Session ids are uuids from the harness, but never trust a path component
  // you did not generate.
  return join(dir, sessionId.replace(/[^a-zA-Z0-9-]/g, "") + ".json");
}

function main() {
  if (process.env.OPENVAULT_NUDGE === "0") return;

  const payload = JSON.parse(rawInput || "{}");
  // Re-entry from our own nudge. Without this the hook can hold a session in a
  // loop it cannot leave.
  if (payload.stop_hook_active) return;

  const { session_id: sessionId, transcript_path: transcriptPath } = payload;
  if (!sessionId || !transcriptPath || !existsSync(transcriptPath)) return;

  const sp = statePath(sessionId);
  let lastLine = 0;
  try {
    if (existsSync(sp)) lastLine = JSON.parse(readFileSync(sp, "utf8")).lastLine ?? 0;
  } catch {
    lastLine = 0;
  }

  const lines = readFileSync(transcriptPath, "utf8").split("\\n");
  let edits = 0;
  let turns = 0;
  let wroteBack = false;

  for (let i = lastLine; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let rec;
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const msg = rec.message;
    if (!msg) continue;
    if (msg.role === "assistant") turns++;
    if (!Array.isArray(msg.content)) continue;
    for (const b of msg.content) {
      if (b?.type !== "tool_use") continue;
      if (WROTE_BACK.test(b.name)) wroteBack = true;
      else if (DID_WORK.test(b.name)) edits++;
    }
  }

  // The session already wrote back. Reset the window and stay out of the way.
  if (wroteBack) {
    writeFileSync(sp, JSON.stringify({ lastLine: lines.length }));
    return;
  }
  if (edits < EDITS && turns < TURNS) return;

  writeFileSync(sp, JSON.stringify({ lastLine: lines.length }));

  const what = edits >= EDITS ? \`\${edits} file edit\${edits === 1 ? "" : "s"}\` : \`\${turns} turns\`;
  // stderr on exit 2 is handed back to the model, which then continues.
  process.stderr.write(
    \`OpenVault checkpoint — \${what} since the last one, and nothing written back yet.\\n\` +
      \`\\n\` +
      \`Is there anything here the next session would otherwise have to rediscover?\\n\` +
      \`What earns a note: a decision AND its reasoning (including what you rejected); a gotcha with\\n\` +
      \`symptom, cause and fix; how a subsystem actually works once you have read it; measured numbers\\n\` +
      \`rather than adjectives; and anything the user corrected you about.\\n\` +
      \`\\n\` +
      \`If yes: search first, then import_notes for atomic notes or append_update for a progress line.\\n\` +
      \`Update an existing note rather than adding a near-duplicate.\\n\` +
      \`\\n\` +
      \`If nothing here is durable, say so in one line and stop. Do NOT invent something to record —\\n\` +
      \`a vault of filler is worse than a small one.\\n\`,
  );
  process.exit(2);
}

let rawInput = "";
try {
  rawInput = await readStdin();
  main();
} catch {
  // A checkpoint is a convenience. It must never interrupt anyone's work, so
  // every failure exits 0 in silence.
}
process.exit(0);
`;
    return new Response(js, {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "content-disposition": `attachment; filename="openvault-nudge.mjs"`,
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
  // force: this is the replica's sole writer and git is the source of truth,
  // so replacing whatever the mirror holds is the entire point. Every other
  // caller must send baseHash instead; only CI gets to say "git wins".
  const r = await call("sync_code", { projectId: PROJECT, ref, files: batches[i], actor: "ci", force: true });
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
  \`read_code\` (one file) serve the latest synced mirror. For more than a file
  or two, materialise a working copy instead — \`scripts/checkout-mirror.ts\`
  from the OpenVault repo pulls the whole mirror to a local directory so you
  work with your normal file tools at native speed.
- **Check \`list_suggestions\` for this project.** Open proposals may already
  cover what you're about to do — and if you work for the project's owner,
  pending ones are waiting on your review.

## Shared files: documents, screenshots, assets

- \`list_files\` shows what has been uploaded to this project; \`read_file\`
  returns a document's extracted text, or an IMAGE you can actually look at.
- Uploads are searchable by their CONTENT, so \`search\` finds a phrase inside
  a PDF or a slide deck, not just its filename.
- **An asset that belongs in the repo — a wallpaper, a logo, a font — must be
  fetched, never retyped.** \`read_file\` returns a \`downloadPath\`; GET it
  from this vault with your account token and write the bytes straight to the
  destination. No model can reproduce a PNG by hand, and a "close enough" one
  is a corrupt file.
- Binary files cannot travel through \`suggest_change\` (it anchors on text).
  Download the asset into the checkout, then propose the CODE that references
  it as a normal anchored edit.

## Changing code you cannot push yourself — SUGGEST, don't fix

If you have no git access here, or the mirror is a replica (sync_code will
refuse you and say so): your deliverable IS a suggestion in the queue. Not a
note describing the fix, not prose telling the owner what to run, not an
explanation of what you would do if you could — work the owner has to
reconstruct from prose is undelivered work. If you catch yourself writing
"change X to Y" anywhere outside \`suggest_change\`, stop and file it.

- \`suggest_change\` takes content-anchored edits — the EXACT text to replace
  and what it becomes, never line numbers. For a NEW file, send edits with
  \`before: ""\` carrying the content (several parts if it's big). To propose
  REMOVING a file, pass \`deleteFile: true\`. The \`reason\` is required and
  becomes a note that outlives the review.
- Edited a working copy? \`scripts/propose-changes.ts\` diffs it against its
  base and files everything — edits, new files, deletions — automatically.
- Filed something wrong or superseded? \`withdraw_suggestion\` takes back your
  own open proposal.
- Approval hands the OWNER the result to apply in their real checkout. The
  vault never writes to git; nothing lands that a human didn't apply.

## When you finish — review, then the handover

- On a workspace-mode mirror: \`sync_code\` the files you changed (diff hashes
  via \`get_code_map\`, ALWAYS pass \`baseHash\`), then \`update_work\` with
  \`status: "in_review"\`. On a replica-mode mirror there is nothing to sync —
  your suggestions ARE the submission.
- **Do NOT \`git push\` yet.** An owner/executive reviews and calls
  \`review_work\` — approve means merge/push now; request_changes comes back
  with a note in \`get_active_work\`. Address it and resubmit.
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
- **Measured numbers**, never adjectives. "117 files, 0 hash mismatches" beats
  "the mirror looks fine". Say what you compared, too: a ratio between two
  things that answer different questions is not a saving.
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

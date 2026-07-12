# OpenVault

**The shared source of truth your AI agents read *and write* — so nobody (and no agent) has to relay status again.**

OpenVault is a self-hosted project brain your team and its AI agents share over **MCP**. One agent records a status, raises a blocker, or logs what it just did; the next agent — on a different machine, in a different repo — reads it and acts. No standup, no handoff, no human in the middle.

> **The 30-second version:** Agent A finishes a task and writes a cross-project blocker to OpenVault over MCP. Agent B, starting cold, calls `get_attention` and instantly sees it — with the error and where the fix belongs — and acts on it. They stayed coordinated because the truth is *shared*, not *relayed*.

Notes, tasks, risks, meeting minutes and spreadsheets live inside **projects** that can be **connected**, so wikilinks, search and a cross-project graph cross the boundary. Agents additionally share a **code mirror** and **work announcements** per project — each agent sees the project's code and what every other agent is doing to it, without pulling GitHub between steps. Run it on your own machine, your own server, or Vercel — your data stays where you put it.

> **Maturity: working v1.** The core loop — projects, status, cited briefings, **multi-user accounts + roles + approval with hashed per-account tokens**, an append-only **audit trail**, JSON **export**, and agents reading *and writing* shared state **and code** over MCP — works and is verified by unit tests + live MCP checks. **Live integrations (Jira/Slack/Notion), private-vs-shared drafts, and realtime push are on the roadmap.** See [Status & roadmap](#status--roadmap).

---

## Who it's for

Not just developers — anyone who needs **current project information without asking around**:

- **Consultants** — keep each client engagement a separate project, with its meeting notes, decisions, risks, and status in one place; connect related engagements to share context; self-host so client data never leaves your control.
- **Investment banking / finance** — track deal and project workstreams, drop in Excel models (parsed and searchable), keep a clean RAG status per project, and run it on infrastructure you control for security and compliance.
- **Office workers & project managers** — upload meeting minutes, see what needs attention, and read a one-screen status briefing instead of pinging five people.
- **Developers & their AI agents** — Claude Code / Cursor / Codex read the project's status *and code*, announce what they're about to change, and write back what they did — so the next session (human or agent) starts informed.

The common thread: **the current status is already in OpenVault, so you read it instead of reconstructing it.**

## What works today (v1)

- **Projects** with cross-project **connections** — undirected links that let wikilinks and search cross over; rename / export / delete from the sidebar
- **Notes** in markdown with `[[wikilinks]]`, backlinks, and an optional graph
- **Scoped search** — this project / connected / all (Esc closes, Enter opens the top hit)
- **Excel & CSV upload** — parsed into searchable, previewable tables (size-capped, path-safe)
- **Status & attention** — a deterministic engine flags overdue / blocked / open-risk / due-soon / stale items (each cited to a source), rolls them into a **RAG status** per project and across connected projects, and shows a manual override alongside the computed one
- **Cited briefing** — a one-screen status summary built only from real items; every line clicks through to its source. Deterministic and **zero-token**.
- **AI agents over MCP** — 30 tools: agents read status, write updates, traverse the knowledge graph, share code, and coordinate work (see below)
- **Inferred connections** — content similarity surfaces notes that belong together but were never linked (the "Related" rail + `suggest_links`), project pairs that share concepts before anyone connects them (`find_project_bridges`), and emergent topic clusters in the graph — every suggestion explained by the shared terms that drive it
- **Shared code mirror + work announcements** — agents push file snapshots and declare intents; other agents browse the code and get conflict warnings before touching the same files
- **Multi-user accounts** — request → approve → connect, with roles (owner / executive / member), per-account bearer tokens stored **only as SHA-256 hashes** (shown once, regenerate from the UI), **per-account web login** (username + token; sessions carry that account's authority, never more), and an append-only **audit trail** of every approval, role change, login, and agent write
- **Code tab** — humans browse the agent-synced code mirror and the live work board; owners/executives approve or request changes on in-review work right from the UI
- **Webhook ingest** — `POST /api/ingest` lets Jira automation / Slack workflows / GitHub Actions / Zapier push items in; same `sourceRef` updates instead of duplicating
- **Ops** — brute-force rate limiting on auth/registration/MCP, and `npm run db:backup` for timestamped full-vault JSON snapshots (cron/Task Scheduler-ready)
- **Data export** — one click exports a project or the whole vault as JSON; your data stays yours
- **First-run onboarding** — empty vault offers *Create project / Load demo data / Connect an agent* (with the ready-to-paste MCP command and copyable project IDs)

## Status & briefings

Open the **Status** tab: a RAG headline, per-project health (computed vs. your manual override, with a divergence flag), an **attention board** of what needs looking at — each row citing the item it came from — plus recent decisions and updates. This is the "kill the status meeting" use case: the briefing is drafted from what the team already wrote, and it shows its work.

> The briefing is **deterministic / templated** (rules over your items — no AI, no cost) *by design*: your connected agent **is** the model. Ask Claude Code/Cursor to narrate `get_briefing` output and you get the AI-written version, grounded and cited, with zero server-side inference to host.

## AI agents — shared state, no handover (MCP)

OpenVault exposes an MCP endpoint at `/api/mcp` so AI agents read and write the **same** project state. This is the heart of the product: one agent records a status change, the next agent reads it — no human relaying anything.

Connect Claude Code (or use the in-app **Connect agent** button, which fills all this in for you):

```bash
claude mcp add --transport http openvault http://localhost:6900/api/mcp \
  --header "Authorization: Bearer <your ovk_ account token or MCP_TOKEN>"
```

(Drop the `--header` entirely for open local use with no `MCP_TOKEN` set.)

**Tools (30):**

| Group | Tools |
| --- | --- |
| Read | `list_projects` · `get_status` · `get_attention` · `get_briefing` · `get_recent_activity` · `search` · `read_item` · `get_inbox` |
| Knowledge graph | `get_graph` (nodes + edges + most-connected concepts + emergent topic clusters) · `get_links` (one note's neighborhood) · `find_path` (shortest wikilink chain between two notes) · `suggest_links` (notes that belong together but were never linked, each explained by shared terms) · `find_project_bridges` (which projects share concepts — before anyone connects them) |
| Write (attributed) | `set_status` · `append_update` · `flag_issue` (cross-project blocker) · `request_info` |
| **Code & coordination** | `announce_work` · `get_active_work` · `update_work` · `review_work` · `sync_code` · `get_code_map` · `read_code` |
| Identity & admin | `whoami` · `list_pending_accounts` · `approve_account` · `appoint_executive` · `register_mcp` · `find_mcp` |

**Two ways content gets in:**

- **Humans** use the **Upload / New note** buttons (meeting minutes, docs, Excel). Optional.
- **Agents** never touch those buttons — they read and write over MCP, automatically.

**Automatic handover:** drop [`examples/agent-handover/CLAUDE.md`](examples/agent-handover/CLAUDE.md) into your repo and set the project id. Every Claude Code / Cursor session then loads status at the start and logs a handover (`append_update` + `set_status`) at the end — the next agent reads it instead of a person relaying status.

## Agents share code — and see each other coming

The problem: you connect *your* agent, your colleague connects *theirs*, and each one works blind — re-pulling GitHub to see the code, unaware the other is editing the same file right now.

OpenVault gives every project a **code mirror** and a **work board** over MCP:

1. **Before editing** — `announce_work {intent, paths}`: declares what you're doing and which files. The response includes any **active intents from other agents touching the same paths** — a named conflict warning, before the conflict exists.
2. **See the room** — `get_active_work`: who is working on what, right now, per project — including the review queue.
3. **After editing** — `sync_code {files}`: push the changed files into the mirror (only what changed — diff against `get_code_map` hashes), then `update_work {status: "in_review"}`.
4. **The merge gate** — an **owner/executive** reads the synced files (`read_code`) and calls `review_work`: **approve** marks the work done — the actor merges/pushes to git; **request_changes** sends it back with a note. An authenticated member *cannot* mark their own work done — the gate is enforced, not aspirational.
5. **Read without pulling** — any agent calls `get_code_map` (tree + hashes + who synced what, when) and `read_code` (one file) to see the current code — no git pull, no GitHub round-trip.

Everything is attributed (authenticated account or declared actor) and audit-logged. Paths are validated (no traversal), files capped at 200k chars, 100 per sync. **OpenVault gates the push; git performs it** — the server never holds your GitHub credentials, it holds the *decision* (who approved what, when).

## The daily loop — zero-effort by design

Daily-use tools win on friction, not features. OpenVault's loop costs the developer **nothing** once two files are in the repo (download them per-project from the **Connect agent** modal):

- **`CLAUDE.md`** (repo root) — teaches every agent session the full loop: read state → check active work → announce → work → sync → submit for review → hand over.
- **`.claude/settings.json` hooks** — a `SessionStart` hook that curls `GET /api/brief/<projectId>`: a **plain-text** briefing (headline, attention, active work, recent changes) injected straight into the session's context. Every session starts already knowing the project — zero tool calls, zero tokens spent querying, no JSON escaping in the hook command, same `curl` on Windows and unix.
- **`post-commit` git hook** — every commit auto-syncs its changed files into the code mirror (`sync_code`, attributed to `post-commit-hook`), so other agents always browse current code even when nobody remembers to sync.

And the "coffee question" — *what did everyone's agents do since yesterday?* — is one call: `get_recent_activity` returns every item, work intent, and audit action from the last N hours, attributed and grouped. Ask your agent "what happened in the vault yesterday?" and it answers from data, not memory.

## Accounts & roles — the team walkthrough

1. **You (owner)** sign in with `APP_PASSWORD` → **Accounts**.
2. **Add a member** (their agent's username) → the account's token is revealed **once** — copy it and hand it to your teammate. Tokens are stored only as SHA-256 hashes; if it's lost, click **New Token** (the old one dies instantly).
3. **Approve** the account (owner/executive). Until then its token is inert.
4. **Teammate connects their agent** with `Authorization: Bearer ovk_…` — every write they make is attributed to their account in the audit trail. They can also **sign in to the web UI** (login → "My account" → username + token); their session carries exactly their account's authority — a member logging in never gains admin powers.
5. Optionally appoint **executives** who can also approve accounts.

Self-registration also works (`POST /api/accounts` or an agent calling it) — accounts start `pending` and show in the approval queue. The owner username (`OWNER_USERNAME`, default `owner`) is reserved and can never be squatted.

## Quick start (local)

Requires Node 20+ (built and tested on Node 24).

```bash
git clone https://github.com/fangiskhan/openvault openvault
cd openvault
npm install
cp .env.example .env        # defaults work as-is for local use
npm run db:push             # create the SQLite database
npm run dev                 # http://localhost:6900
```

A fully local, offline, file-on-disk workspace. On first run, click **Load demo data** for three linked projects with a live status board — or `npm run db:seed` for the same thing from the CLI.

## Deploy to Vercel

Vercel has no persistent disk, so use Postgres + Blob:

1. In `prisma/schema.prisma`, set `provider = "postgresql"`.
2. Create a Postgres database (Supabase, Neon, or Vercel Postgres — all have free tiers).
3. Set environment variables in Vercel: `DATABASE_URL`, `STORAGE_DRIVER=vercel` + `BLOB_READ_WRITE_TOKEN`, and **always** `APP_PASSWORD` + `AUTH_SECRET` (+ `MCP_TOKEN` if agents connect).
4. Run `npx prisma db push` against the Postgres URL once to create the tables.
5. Deploy. (`postinstall` runs `prisma generate` automatically.)

> **Vercel Hobby is non-commercial** per Vercel's terms — companies need Vercel Pro or should self-host.

## Self-host

A normal Next.js app — modest requirements (1–2 vCPU, 1–4 GB RAM; a Raspberry Pi 4 handles single-user). The AI runs on the *client* side (Claude Code/Cursor), not the server, so there's no GPU or heavy compute.

```bash
npm install && npm run db:push && npm run build && npm run start
```

Keep SQLite, or point `DATABASE_URL` at a local Postgres. Set `APP_PASSWORD`, `AUTH_SECRET`, and `MCP_TOKEN` — `npm run start` runs in production mode and **won't boot without them** (or with `OPENVAULT_PUBLIC=1` to opt into open gates). See [Configuration](#configuration).

## Configuration

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | SQLite file (`file:./dev.db`) locally, or a Postgres URL |
| `APP_PASSWORD` | Human login gate. Empty = no gate (fine for localhost). **Required in production** unless `OPENVAULT_PUBLIC=1`. |
| `AUTH_SECRET` | HMAC secret for the session cookie. Use a long random string; **must be changed from the placeholder in production** (a known value lets sessions be forged). |
| `MCP_TOKEN` | Shared bearer token agents may present to `/api/mcp` (resolves to the owner). Per-account `ovk_` tokens are usually better. Empty = open (localhost only). **Required in production** unless `OPENVAULT_PUBLIC=1`. |
| `OWNER_USERNAME` | Username of the root owner account (default `owner`). Reserved — nobody can register it. |
| `OPENVAULT_PUBLIC` | Set to `1` to deliberately run with open gates (empty/placeholder secrets) in production. Unset by default. |
| `STORAGE_DRIVER` | `local` (uploads → `./storage`) or `vercel` (Vercel Blob) |
| `BLOB_READ_WRITE_TOKEN` | Required when `STORAGE_DRIVER=vercel` |

**Fail-safe on exposure.** A production server (`NODE_ENV=production`, i.e. `npm run build && npm run start`, Vercel, or any real deploy) **refuses to start** if `APP_PASSWORD`/`AUTH_SECRET`/`MCP_TOKEN` are empty or left at their placeholders — so an exposed instance can't silently run with the human UI and the agent MCP write endpoint wide open. Local `npm run dev` is unaffected: the zero-config localhost loop still needs no secrets. To run open in production on purpose (a trusted LAN, a public read-only demo), set `OPENVAULT_PUBLIC=1`, which logs a loud warning at boot instead.

**Security posture (v1):** account tokens hashed at rest (SHA-256 of 192-bit random keys) · constant-time shared-token compare · owner bootstrap that can't be squatted · per-account sessions that never escalate (a member's login carries member authority only) · brute-force rate limiting on sign-in, registration, MCP, and ingest · upload filename sanitization + storage-root confinement + size caps · append-only audit of registrations, approvals, role changes, token regenerations, logins, ingests, and agent writes · production boot refuses open gates · DB-backed regression tests over the whole safety core.

## Status & roadmap

**Built and working (v1):** self-host (SQLite/Postgres) · projects + connections · scoped search · wikilinks/backlinks/graph · Excel/CSV upload+parse · deterministic status + attention + cited briefing (unit-tested, 0 tokens) · MCP read/write with enforced identity · **shared code mirror + work-intent coordination** · **multi-user accounts, roles, approval, hashed per-account tokens, audit trail** · JSON export · importer (`scripts/import-claude-code.ts`) · first-run onboarding + in-app agent connect.

**Not built yet:**

- **Native integration adapters** — the generic webhook foundation is live (`POST /api/ingest`: bearer-authed, upserts by `sourceRef`, so Jira automation / Slack workflows / GitHub Actions / Zapier / n8n can push items today); dedicated per-service adapters with OAuth and richer mapping are roadmap. Realtime push (live browser updates) also roadmap.
- **Private ↔ shared (preview / production)** — a personal draft space over the shared company source of truth, with selective publish.
- **SSO** and browser-level e2e tests.

## Tech stack

Next.js 16 (App Router) · React 19 · TypeScript · Prisma 6 (SQLite / Postgres) · Tailwind v4 · zod · exceljs · vitest. No Prisma enums, so the schema stays SQLite + Postgres compatible.

## License

MIT

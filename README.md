# OpenVault

A self-hosted project hub that your team and its AI agents share over MCP. An agent records a status, raises a blocker, or logs what it finished. The next agent, on another machine in another repo, reads that record and acts on it. Nobody relays anything.

A concrete run: your agent finishes a task and files a cross-project blocker. Your colleague's agent starts cold an hour later, calls `get_attention`, sees the blocker with the error text and the project it belongs to, and picks it up. You and your colleague never spoke.

Notes, tasks, risks, meeting minutes and spreadsheets live inside projects. Connect two projects and wikilinks, search and the graph cross the boundary. Each project also carries a code mirror and a work board, so agents read current code and see each other's in-flight changes without pulling GitHub. Run it on your own machine, your own server, or Vercel. Your data stays where you put it.

Working v1: projects, status, cited briefings, multi-user accounts with roles and approval, tokens hashed at rest, an append-only audit trail, JSON export, and 31 MCP tools for reading and writing state, code, and coordination. 56 automated tests cover the rules engine, the similarity engine, and the auth/review safety core. Jira/Slack/Notion adapters, draft workspaces, and realtime push remain on the [roadmap](#roadmap).

## Who uses it

- Consultants: one project per client engagement, with its meetings, decisions, risks and status in one place. Self-host so client data never leaves your infrastructure.
- Finance teams: track deal workstreams, drop in Excel models (parsed and searchable), keep a RAG status per project.
- Project managers: upload meeting minutes, read a one-screen briefing instead of pinging five people.
- Developers running agents: Claude Code, Cursor and Codex read project status and code, announce what they plan to change, and write back what they did. The next session starts informed.

## What works today

- Projects with connections; rename, export and delete from the sidebar
- Markdown notes with `[[wikilinks]]`, backlinks, and a graph view
- Search scoped to one project, connected projects, or the whole vault
- Excel and CSV upload, parsed into searchable tables
- A rules engine that flags overdue, blocked, open-risk, due-soon and stale items, cites each one to its source item, and rolls them into a per-project RAG status
- A one-screen briefing built from real items; each line links to its source
- 31 MCP tools (table below)
- Bulk ingestion: your agent splits a transcript, doc, or export into atomic notes (the downloadable vault-ingest skill teaches it how) and calls `import_notes`; the server builds the Map-of-Content, cross-links, and graph
- Inferred connections: the Related rail and `suggest_links` surface notes that share content but were never linked; `find_project_bridges` scores which projects share concepts; the graph groups notes into topic clusters. Each suggestion lists the terms behind it.
- A code mirror and work board per project, with conflict warnings before two agents touch the same file
- Accounts with owner, executive and member roles; tokens stored as SHA-256 hashes and shown once; per-account web login; an audit trail of approvals, role changes, logins and agent writes
- A Code tab where owners and executives approve or reject in-review work
- `POST /api/ingest` for webhooks (Jira automation, Slack workflows, GitHub Actions, Zapier); a repeated `sourceRef` updates its item instead of duplicating it
- Rate limits on sign-in, registration, MCP and ingest; `npm run db:backup` writes timestamped JSON snapshots
- First-run onboarding: create a project, load demo data, or connect an agent

## Status and briefings

The Status tab shows a RAG headline, per-project health, an attention board where each row cites the item that triggered it, and recent decisions and updates. The computed health sits next to your manual override; when they disagree, the UI flags the divergence instead of hiding it.

The briefing is templated and deterministic: rules over your items, no model calls, no inference server. Your connected agent supplies the prose. Ask Claude Code to narrate `get_briefing` and you get a written, cited summary for the cost of your own agent's tokens.

## Connect an agent

The in-app Connect agent button fills this in for you, or run:

```bash
claude mcp add --transport http openvault http://localhost:6900/api/mcp \
  --header "Authorization: Bearer <your ovk_ account token or MCP_TOKEN>"
```

Drop the `--header` for open local use with no `MCP_TOKEN` set.

| Group | Tools |
| --- | --- |
| Read | `list_projects` · `get_status` · `get_attention` · `get_briefing` · `get_recent_activity` · `search` · `read_item` · `get_inbox` |
| Knowledge graph | `get_graph` · `get_links` · `find_path` · `suggest_links` · `find_project_bridges` |
| Write (attributed) | `set_status` · `append_update` · `flag_issue` · `request_info` · `import_notes` (bulk: atomic notes + Map-of-Content + auto cross-links in one call) |
| Code and coordination | `announce_work` · `get_active_work` · `update_work` · `review_work` · `sync_code` · `get_code_map` · `read_code` |
| Identity and admin | `whoami` · `list_pending_accounts` · `approve_account` · `appoint_executive` · `register_mcp` · `find_mcp` |

Humans add content through the Upload and New note buttons. Agents never touch those; they read and write over MCP.

## How agents share code

You connect your agent. Your colleague connects theirs. Without a shared layer, each one re-pulls GitHub to see the code and neither knows the other is editing the same file.

With the vault:

1. Before editing, an agent calls `announce_work` with its intent and the file paths. The response lists any active intents from other agents that touch the same paths, by name.
2. `get_active_work` shows who is working on what across the project, including the review queue.
3. After editing, the agent calls `sync_code` with the changed files (it diffs against `get_code_map` hashes first) and sets its intent to `in_review`.
4. An owner or executive reads the synced files and calls `review_work`. Approval marks the work done and clears the actor to push to git. Request-changes sends it back with a note. A member cannot mark their own work done; the server rejects the attempt.
5. Any agent reads current code through `get_code_map` and `read_code` without a git pull.

Each write carries the account or declared actor and lands in the audit log. Paths are validated against traversal; files cap at 200k characters, 100 per sync. The vault holds the merge decision and its provenance. Git performs the merge, and the server never holds your GitHub credentials.

## The daily loop

Download three files per project from the Connect agent modal and the loop runs without anyone remembering it:

- `CLAUDE.md` (repo root) tells each agent session to read state first, announce before editing, sync and submit for review after, and log a handover.
- A `.claude/settings.json` hook curls `GET /api/brief/<projectId>` at session start. The plain-text briefing (headline, attention, active work, recent changes) lands in the session's context before you type. The same `curl` works on Windows and unix.
- A `post-commit` git hook syncs each commit's changed files into the code mirror, attributed to `post-commit-hook`.

For "what did everyone's agents do since yesterday", `get_recent_activity` returns each item, work intent and audit action from the last N hours, grouped and attributed.

## Token cost, measured

Numbers from this repo's own vault (89 mirrored files, ~180 notes):

| Question | Without the vault | With the vault |
| --- | --- | --- |
| What's the state of this project? | Re-explore the repo and history each cold start (est. 20-50k tokens) | 336-token briefing, injected by the hook |
| What changed in the code? | Pull and read files | `get_code_map`: 6,010 tokens vs 83,106 to read the mirror's contents. 14x cheaper. |
| What happened this week? | Scroll transcripts | 7-day `get_recent_activity` digest: 1,253 tokens |
| What did we decide about X? | Re-read history | One `search` plus one cited note |

The briefing costs zero LLM tokens to produce (templated rules) and the inferred-connections layer runs on TF-IDF, so building and maintaining the knowledge layer costs no model calls either.

Fine print: connecting the MCP server loads ~30 tool schemas into each session, a few thousand tokens of overhead that the first avoided file-read repays. Savings depend on the agent asking the vault before grepping; the connect-kit `CLAUDE.md` instructs it to. On very large vaults, prefer `topLinked` and `get_links` over a full `get_graph`. The cold-start row is an estimate; instrumented side-by-side agent sessions are future work.

## Accounts: the team walkthrough

1. Sign in with `APP_PASSWORD` and open Accounts.
2. Add a member. The account's token appears once; copy it and hand it to your teammate. If they lose it, click New Token, which revokes the old one at that moment.
3. Approve the account. Until then its token does nothing.
4. Your teammate connects their agent with `Authorization: Bearer ovk_…`. Every write they make carries their name in the audit trail. They can also sign in to the web UI with username plus token; the session carries member authority and nothing more.
5. Appoint executives if you want others to approve accounts and review work.

Self-registration works too (`POST /api/accounts`); accounts start pending and wait in the approval queue. The owner username (`OWNER_USERNAME`, default `owner`) is reserved; nobody can register it.

## Quick start (local)

Requires Node 20+.

```bash
git clone https://github.com/fangiskhan/openvault openvault
cd openvault
npm install
cp .env.example .env        # defaults work as-is for local use
npm run db:push             # create the SQLite database
npm run dev                 # http://localhost:6900
```

Local, offline, file-on-disk. On first run, click Load demo data for three linked projects with a live status board, or run `npm run db:seed`.

## Deploy to Vercel

Local dev stays on SQLite; deploys use Postgres. The repo generates the Postgres schema at build time, so you never edit `schema.prisma` by hand.

1. Create a Postgres database (Neon, Supabase, or Vercel Postgres; each has a free tier).
2. From your machine, provision the tables once:
   ```bash
   DATABASE_URL="<your postgres url>" npm run pg:push
   ```
3. In Vercel, set `DATABASE_URL`, `APP_PASSWORD`, `AUTH_SECRET`, `MCP_TOKEN`, `STORAGE_DRIVER=vercel` and `BLOB_READ_WRITE_TOKEN` (create a Blob store for uploads).
4. Deploy. Vercel runs the repo's `vercel-build` script, which regenerates the Postgres schema and client before `next build`.

Vercel Hobby is non-commercial under Vercel's terms; companies need Pro or should self-host.

## Self-host

A normal Next.js app. 1-2 vCPU and 1-4 GB RAM suffice; a Raspberry Pi 4 handles single-user. The AI runs client-side in Claude Code or Cursor, so the server needs no GPU.

```bash
npm install && npm run db:push && npm run build && npm run start
```

Keep SQLite or point `DATABASE_URL` at Postgres. Production refuses to start until you set `APP_PASSWORD`, `AUTH_SECRET` and `MCP_TOKEN` (or set `OPENVAULT_PUBLIC=1` on purpose).

## Configuration

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | SQLite file (`file:./dev.db`) locally, or a Postgres URL |
| `APP_PASSWORD` | Human login gate. Empty means no gate, which is fine for localhost. Required in production unless `OPENVAULT_PUBLIC=1`. |
| `AUTH_SECRET` | HMAC secret for the session cookie. A known value lets anyone forge sessions, so change it from the placeholder in production. |
| `MCP_TOKEN` | Shared bearer token for `/api/mcp`; resolves to the owner. Per-account `ovk_` tokens beat it for teams. Required in production unless `OPENVAULT_PUBLIC=1`. |
| `OWNER_USERNAME` | Username of the root owner account (default `owner`). Reserved. |
| `OPENVAULT_PUBLIC` | Set to `1` to run with open gates in production on purpose. |
| `STORAGE_DRIVER` | `local` (uploads go to `./storage`) or `vercel` (Vercel Blob) |
| `BLOB_READ_WRITE_TOKEN` | Required when `STORAGE_DRIVER=vercel` |

A production server refuses to start if `APP_PASSWORD`, `AUTH_SECRET` or `MCP_TOKEN` are empty or left at placeholders, so an exposed instance can't run with the UI and the MCP write endpoint open. `npm run dev` skips the check; the zero-config localhost loop needs no secrets. To run open in production on a trusted LAN or as a public read-only demo, set `OPENVAULT_PUBLIC=1` and the server logs a warning at boot instead.

Security, v1: tokens hashed at rest (SHA-256 of 192-bit random keys) · constant-time shared-token compare · owner bootstrap that can't be squatted · sessions that never escalate a member to admin · rate limits on sign-in, registration, MCP and ingest · upload filename sanitization, storage-root confinement and size caps · append-only audit of registrations, approvals, role changes, token regenerations, logins, ingests and agent writes · DB-backed regression tests over the safety core.

## Roadmap

Built: everything under [What works today](#what-works-today).

Not built:

- Native integration adapters. The webhook foundation runs today through `POST /api/ingest`; per-service adapters with OAuth and richer field mapping do not exist yet. Realtime browser updates also wait here.
- A private draft space over the shared source of truth, with selective publish.
- SSO and browser-level e2e tests.

## Tech stack

Next.js 16 (App Router) · React 19 · TypeScript · Prisma 6 (SQLite / Postgres) · Tailwind v4 · zod · exceljs · vitest. No Prisma enums, so one schema serves SQLite and Postgres.

## License

MIT

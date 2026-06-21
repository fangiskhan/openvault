# OpenVault

**The shared source of truth your AI agents read *and write* — so nobody (and no agent) has to relay status again.**

OpenVault is a self-hosted project brain your team and its AI agents share over **MCP**. One agent records a status, raises a blocker, or logs what it just did; the next agent — on a different machine, in a different repo — reads it and acts. No standup, no handoff, no human in the middle.

> **The 30-second version:** Agent A finishes a task and writes a cross-project blocker to OpenVault over MCP. Agent B, starting cold, calls `get_attention` and instantly sees it — with the error and where the fix belongs — and acts on it. They stayed coordinated because the truth is *shared*, not *relayed*. *(demo clip ↓)*

Notes, tasks, risks, meeting minutes and spreadsheets live inside **projects** that can be **connected**, so wikilinks, search and a cross-project graph cross the boundary. Run it on your own machine, your own server, or Vercel — your data stays where you put it.

> **Maturity: working v1 / MVP.** The core loop — projects, status, cited briefings, **accounts + roles + approval**, and agents reading *and writing* shared state over MCP — works and is verified. **Per-account web login, live sync, integrations (Jira/Slack/Notion), and the AI-written briefing are on the roadmap.** See [Status & roadmap](#status--roadmap).

---

## Who it's for

Not just developers — anyone who needs **current project information without asking around**:

- **Consultants** — keep each client engagement a separate project, with its meeting notes, decisions, risks, and status in one place; connect related engagements to share context; self-host so client data never leaves your control.
- **Investment banking / finance** — track deal and project workstreams, drop in Excel models (parsed and searchable), keep a clean RAG status per project, and run it on infrastructure you control for security and compliance.
- **Office workers & project managers** — upload meeting minutes, see what needs attention, and read a one-screen status briefing instead of pinging five people.
- **Developers & their AI agents** — Claude Code / Cursor / Codex read the project's status and write back what they did, so the next session (human or agent) starts informed.

The common thread: **the current status is already in OpenVault, so you read it instead of reconstructing it.**

## What works today (v1)

- **Projects** with cross-project **connections** — undirected links that let wikilinks and search cross over
- **Notes** in markdown with `[[wikilinks]]`, backlinks, and an optional graph
- **Scoped search** — this project / connected / all
- **Excel & CSV upload** — parsed into searchable, previewable tables (models, trackers, data)
- **Status & attention** — a deterministic engine flags overdue / blocked / open-risk / due-soon / stale items (each cited to a source), rolls them into a **RAG status** per project and across connected projects, and shows a manual override alongside the computed one
- **Cited briefing** — a one-screen status summary built only from real items; every line clicks through to its source. Deterministic and **zero-token**.
- **AI agents over MCP** — agents read status and write updates (see below)
- **Single-user** password login

## Status & briefings

Open the **Status** tab: a RAG headline, per-project health (computed vs. your manual override, with a divergence flag), an **attention board** of what needs looking at — each row citing the item it came from — plus recent decisions and updates. This is the "kill the status meeting" use case: the briefing is drafted from what the team already wrote, and it shows its work.

> Honest scope: today the briefing is **deterministic / templated** (rules over your items — no AI, no cost). The **AI-written** prose version is on the roadmap and needs a self-hosted inference choice (your own model or endpoint).

## AI agents — shared state, no handover (MCP)

OpenVault exposes an MCP endpoint at `/api/mcp` so AI agents read and write the **same** project state. This is the heart of the product: one agent records a status change, the next agent reads it — no human relaying anything.

Connect Claude Code:

```bash
claude mcp add --transport http openvault http://localhost:3000/api/mcp \
  --header "Authorization: Bearer $MCP_TOKEN"
```

(Drop the `--header` if `MCP_TOKEN` is empty for local use.)

**Tools** — read: `list_projects`, `get_status`, `get_attention`, `get_briefing`, `search`, `read_item`; write (attributed with an `actor`): `set_status`, `append_update`.

**Two ways content gets in:**

- **Humans** use the **Upload / New note** buttons (meeting minutes, docs, Excel). Optional.
- **Agents** never touch those buttons — they read and write over MCP, automatically.

**Automatic handover:** drop [`examples/agent-handover/CLAUDE.md`](examples/agent-handover/CLAUDE.md) into your repo and set the project id. Every Claude Code / Cursor session then loads status at the start and logs a handover (`append_update` + `set_status`) at the end — the next agent reads it instead of a person relaying status.

## Quick start (local)

Requires Node 20+ (built and tested on Node 24).

```bash
git clone https://github.com/fangiskhan/openvault openvault
cd openvault
npm install
cp .env.example .env        # defaults work as-is for local use
npm run db:push             # create the SQLite database
npm run db:seed             # optional: demo projects + a "red" status to look at
npm run dev                 # http://localhost:3000
```

A fully local, offline, file-on-disk workspace. No accounts, no cloud.

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
| `MCP_TOKEN` | Bearer token agents present to `/api/mcp`. Empty = open (localhost only). **Required in production** unless `OPENVAULT_PUBLIC=1`. |
| `OPENVAULT_PUBLIC` | Set to `1` to deliberately run with open gates (empty/placeholder secrets) in production. Unset by default. |
| `STORAGE_DRIVER` | `local` (uploads → `./storage`) or `vercel` (Vercel Blob) |
| `BLOB_READ_WRITE_TOKEN` | Required when `STORAGE_DRIVER=vercel` |

**Fail-safe on exposure.** A production server (`NODE_ENV=production`, i.e. `npm run build && npm run start`, Vercel, or any real deploy) **refuses to start** if `APP_PASSWORD`/`AUTH_SECRET`/`MCP_TOKEN` are empty or left at their placeholders — so an exposed instance can't silently run with the human UI and the agent MCP write endpoint wide open. Local `npm run dev` is unaffected: the zero-config localhost loop still needs no secrets. To run open in production on purpose (a trusted LAN, a public read-only demo), set `OPENVAULT_PUBLIC=1`, which logs a loud warning at boot instead.

## Status & roadmap

**Built and working (v1):** self-host (SQLite/Postgres) · projects + connections · scoped search · wikilinks/backlinks/graph · Excel/CSV upload+parse · deterministic status + attention + cited briefing (unit-tested, 0 tokens) · MCP read/write with basic `actor` provenance · single-user auth.

**Not built yet — needed before a company relies on it:**

- **Multi-user & permissions** — accounts, teams, roles. Today it's a single shared login. *This is the biggest gap.*
- **Private ↔ shared (preview / production)** — a personal draft space over the shared company source of truth, with selective publish.
- **Integrations with live sync** — Jira / Slack / Notion / GitHub. Designed to be **webhook-driven**: e.g. a Jira comment would POST to OpenVault and create/update an Item automatically. (Seeing it change *live in an open browser tab* additionally needs realtime push — also roadmap.)
- **Who's working on what** — assignees + presence. Needs multi-user first; today there's only the `actor` stamp on agent writes.
- **AI-written grounded briefing** — the prose summary, grounded and cited; needs a self-hosted inference path (your own model/endpoint).
- **Import + mapping** — pull existing Jira/Slack/Notion data in and match it onto existing projects/notes for an easy migration.
- **Hardening** — per-user identity / SSO, an audit trail, per-agent MCP tokens, rate limiting, write-concurrency safety, backups, integration/e2e tests.

## Tech stack

Next.js 16 (App Router) · React 19 · TypeScript · Prisma 6 (SQLite / Postgres) · Tailwind v4 · zod · exceljs · vitest. No Prisma enums, so the schema stays SQLite + Postgres compatible.

## License

MIT

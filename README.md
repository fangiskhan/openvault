# OpenVault

A self-hosted, project-centric knowledge hub — Obsidian's linked-markdown idea, pointed at **teams, AI agents, and integrations**, running on **your own infrastructure**.

Notes, meeting minutes, tasks, and spreadsheets all live inside a **project**. Projects are isolated by default, but you can **connect** related projects so links and search cross the boundary. Run it on your own PC, your own server, or deploy it to Vercel — your data stays where you put it.

> **Status:** v1 — the foundation. Notes + projects + connections + scoped search + spreadsheet ingestion, self-hostable and Vercel-deployable. MCP (so Claude Code / Cursor / Codex connect) and Slack/Jira/GitHub integrations are next on the roadmap.

---

## Why this exists

Obsidian is a brilliant *personal* note-taker, but it's single-user local files. It was never built to be a team server that AI agents and tools plug into. OpenVault takes the part worth borrowing — linked markdown — and aims it at a different job:

- **Project-centric.** Search *"Project Atlas"* and get its notes, meetings, and tasks together. Connect Atlas to Orion and links/search reach across; leave Nova unconnected and it stays isolated.
- **Self-hosted = secure by control.** Companies that can't put their knowledge in a cloud SaaS can run their own instance.
- **Built for AI agents.** The data model is designed so an MCP server (next milestone) can expose your notes to Claude Code, Cursor, and Codex.
- **Structured data, not just prose.** Upload Excel/CSV and the rows become trackable, linkable content — built with finance/consulting workflows in mind.

## Features (v1)

- 📁 **Projects** with a colour, slug, and item count
- 🔗 **Connections** between projects — undirected links that let wikilinks and search cross over
- 📝 **Markdown notes** with live preview and `[[wikilinks]]` (click to follow; click a non-existent one to create it)
- ↩️ **Backlinks & links** rail — including cross-project backlinks through connections
- 🔍 **Scoped search** — *This project* · *Connected* · *All*
- 📊 **Spreadsheet upload** (`.xlsx` / `.csv`) parsed into previewable, searchable tables
- 🕸️ **Optional graph view** — project-scoped, opened on demand (calm by default, no bubble cloud in your face)
- 🔐 **Single-user auth** — an optional password gate for when you expose the server
- 💾 **Pluggable storage** — SQLite locally (zero setup), Postgres in production; local disk or Vercel Blob for files

## Quick start (local)

Requires Node 20+ (built and tested on Node 24).

```bash
git clone <your-repo-url> openvault
cd openvault
npm install
cp .env.example .env        # the defaults work as-is for local use
npm run db:push             # create the SQLite database
npm run db:seed             # optional: demo projects + connected notes
npm run dev                 # http://localhost:3000
```

That's it — a fully local, offline, file-on-disk workspace. No accounts, no cloud.

## Deploy to Vercel

Vercel has no persistent disk, so use Postgres + Blob:

1. In `prisma/schema.prisma`, set `provider = "postgresql"`.
2. Create a Postgres database (Supabase, Neon, or Vercel Postgres — all have free tiers).
3. Set environment variables in Vercel:
   - `DATABASE_URL` → your Postgres connection string
   - `STORAGE_DRIVER=vercel` and `BLOB_READ_WRITE_TOKEN` → a Vercel Blob token
   - `APP_PASSWORD` and `AUTH_SECRET` → **always set these before exposing the app**
4. Run `npx prisma db push` against the Postgres URL once to create the tables.
5. Deploy. (`postinstall` runs `prisma generate` automatically.)

> **Note on Vercel Hobby:** the free tier works for personal use but is **non-commercial** per Vercel's terms — companies need Vercel Pro or should self-host.

## Self-host on your own server / PC

It's a normal Next.js app — modest requirements (1–2 vCPU, 1–4 GB RAM; a Raspberry Pi 4 handles single-user). The AI runs on the *client* side (Claude Code/Cursor), not the server, so there's no GPU or heavy compute.

```bash
npm install && npm run db:push && npm run build && npm run start
```

Keep SQLite, or point `DATABASE_URL` at a local Postgres. Set `APP_PASSWORD` + `AUTH_SECRET` if anyone else can reach it.

## Configuration

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | SQLite file (`file:./dev.db`) locally, or a Postgres URL |
| `APP_PASSWORD` | Password gate. Empty = no gate (fine for purely local). **Set before exposing.** |
| `AUTH_SECRET` | HMAC secret for the session cookie. Use a long random string. |
| `STORAGE_DRIVER` | `local` (uploads → `./storage`) or `vercel` (Vercel Blob) |
| `BLOB_READ_WRITE_TOKEN` | Required when `STORAGE_DRIVER=vercel` |

## Roadmap

- **v2 — MCP server.** One endpoint so Claude Code / Cursor / Codex / Cline read and write your notes. Build once, every MCP client connects.
- **v3 — Collaboration.** Accounts, roles, shared workspaces.
- **v4 — Integrations.** Slack, Jira, GitHub → ingest conversations/tickets/activity as Items, linked to projects.
- Editor upgrade to CodeMirror 6, Postgres full-text + semantic (pgvector) search, file download route.

## Tech stack

Next.js 16 (App Router) · React 19 · TypeScript · Prisma 6 (SQLite / Postgres) · Tailwind v4 · exceljs · zod. No Prisma enums (kept SQLite/Postgres-compatible); enumerated values validated with zod.

## License

MIT

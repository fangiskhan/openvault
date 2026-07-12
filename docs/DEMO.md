# The 30-second demo — runbook

One moment must land: **two agents about to collide — and the vault catching it.**
Everything else supports that. Record ~60s of material, cut to 30–40s.

## Prep (once)

1. Server running: `npm run dev` → http://localhost:6900
2. A demo project with a few notes (use **Load demo data** on a fresh vault, or your real project).
3. Two agent identities:
   - Session A = you (`claude` in the repo, normal setup).
   - Session B = "colleague": **Accounts → Add a member** → username `mira` → copy the
     one-time token → approve her. Connect a second Claude Code session with
     `claude mcp add openvault http://localhost:6900/api/mcp --transport http --scope user --header "Authorization: Bearer <mira's token>"`.
4. Connect kit installed in the repo (**Connect agent → CLAUDE.md + Hooks + Git hook**), so:
   - session start injects the briefing (beat 1 films itself),
   - commits print `openvault: mirror synced` (beat 4 films itself).
5. Screen: 1920×1080. Two terminals side by side (tab titles `you` / `mira`), browser
   behind on the **Code** tab. Terminal font 16–18pt.

## The beats

**Beat 1 — the briefing appears (0–4s)**
Start a fresh Session A on camera. The SessionStart hook prints the project briefing
into context before you type anything. Caption: *"Your agent wakes up already knowing the project."*

**Beat 2 — the collision (4–14s) ← the money shot**
- In Session B (mira), paste:
  > announce that you're refactoring src/lib/auth.ts — call announce_work on the openvault MCP with intent "refactoring session auth" and paths ["src/lib/auth.ts"]
- In Session A, paste:
  > I want to fix the token check in src/lib/auth.ts — announce the work first
- Session A's response contains: `CAUTION: mira is actively working on overlapping files`.
  Zoom/crop to that line. Caption: *"Two agents. Same file. Caught before the collision."*

**Beat 3 — the review gate (14–24s)**
- Session A (told to pick different work) finishes something small, then:
  > sync the changed files to openvault and submit the work for review (update_work in_review)
- Switch to the browser Code tab: the intent sits in the review queue. Click **Approve**.
  Caption: *"Nothing lands in git unreviewed."*

**Beat 4 — the push + self-syncing mirror (24–30s)**
- Session A: `git commit` + push. The post-commit hook prints
  `openvault: mirror synced (N file(s), main @ …)` on its own.
  Caption: *"One shared memory — humans and agents. Self-hosted. MIT."* + repo URL.

## Reset between takes

```bash
# abandon demo intents so the board is clean (run in the OpenVault repo)
npx tsx -e "import('./src/lib/db.js')"   # or simply:
```
Easier: open the Code tab and Request-changes/approve stray intents, or run:
```bash
curl -s http://localhost:6900/api/mcp -H "content-type: application/json" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"get_active_work\",\"arguments\":{}}}"
```
then `update_work {intentId, status:"abandoned"}` for each leftover.

## Recording & export (Windows 11, all free)

- **Record**: OBS Studio, or `Win+Alt+R` (Game Bar) for zero setup.
- **Cut + captions**: Clipchamp (built into Windows 11). One caption per beat, large, high-contrast, no audio needed.
- **Export**: MP4 1080p for X / Show HN; GIF ≤10 MB for the README top:
  `ffmpeg -i demo.mp4 -vf "fps=12,scale=960:-1" demo.gif`

## Posting order

1. GIF at the top of README (replaces the promise with proof), push.
2. X post: MP4 + one line — *"Your agents are stepping on each other. I built the layer where they coordinate — self-hosted, MIT, works with Claude Code/Cursor/Codex."*
3. Show HN: *"Show HN: OpenVault – a self-hosted hub where your AI agents share state, code, and a merge gate"* — link the repo, put the MP4 in the first comment.

## Don'ts

- Don't show installs, configs, or empty screens.
- Don't tour features — one story, four beats.
- Don't exceed 45s. If a beat drags, cut the beat, not the pace.

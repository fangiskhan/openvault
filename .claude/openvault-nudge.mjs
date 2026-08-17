// A scheduled decision moment for writing back to OpenVault.
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

  const lines = readFileSync(transcriptPath, "utf8").split("\n");
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

  const what = edits >= EDITS ? `${edits} file edit${edits === 1 ? "" : "s"}` : `${turns} turns`;
  // stderr on exit 2 is handed back to the model, which then continues.
  process.stderr.write(
    `OpenVault checkpoint — ${what} since the last one, and nothing written back yet.\n` +
      `\n` +
      `Is there anything here the next session would otherwise have to rediscover?\n` +
      `What earns a note: a decision AND its reasoning (including what you rejected); a gotcha with\n` +
      `symptom, cause and fix; how a subsystem actually works once you have read it; measured numbers\n` +
      `rather than adjectives; and anything the user corrected you about.\n` +
      `\n` +
      `If yes: search first, then import_notes for atomic notes or append_update for a progress line.\n` +
      `Update an existing note rather than adding a near-duplicate.\n` +
      `\n` +
      `If nothing here is durable, say so in one line and stop. Do NOT invent something to record —\n` +
      `a vault of filler is worse than a small one.\n`,
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

// Materialise a project's OpenVault code mirror as a local working copy — the
// "virtual drive" idea without a filesystem driver. An agent's file tools are
// just file APIs, so a real directory gives it the exact same experience a
// mounted drive would: it reads, greps and edits at native speed instead of
// through windowed read_code calls. Nothing it does here touches the mirror.
// When it is done, scripts/propose-changes.ts diffs this working copy against
// the pristine base and files the changes as content-anchored suggestions for
// the project owner to review.
//
//   npx tsx scripts/checkout-mirror.ts <vaultUrl> <projectIdOrName> <targetDir>
//
// Writes the mirrored tree into <targetDir>, plus:
//   .openvault/checkout.json  — vault URL, project id, ref, per-file hashes
//   .openvault/base/<path>    — pristine copies, so propose can diff offline
//
// Set OPENVAULT_TOKEN when the vault requires auth. The mirror holds text
// files only (no binaries, no .env, nothing over the size cap), so a checkout
// is for reading and editing — not guaranteed to build.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

const [vaultArg, projectArg, dirArg] = process.argv.slice(2);
if (!vaultArg || !projectArg || !dirArg) {
  console.error("usage: npx tsx scripts/checkout-mirror.ts <vaultUrl> <projectIdOrName> <targetDir>");
  process.exit(1);
}
const VAULT = vaultArg.replace(/\/+$/, "");
// Strip a BOM: a token piped into an env var on Windows PowerShell carries one,
// and it lands in the Authorization header as an unencodable character.
const TOKEN = (process.env.OPENVAULT_TOKEN ?? "").replace(/^﻿/, "").trim();

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const res = await fetch(`${VAULT}/api/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as {
    error?: { message?: string };
    result?: { isError?: boolean; content?: Array<{ text?: string }> };
  };
  // JSON-RPC errors arrive as HTTP 200 with an `error` member and NO result.
  // Falling back to "{}" here once made this script write the literal string
  // "undefined" into files while reporting success.
  if (json.error) throw new Error(`${name}: ${json.error.message ?? "JSON-RPC error"} — is this vault older than the working-copy flow?`);
  const text = json.result?.content?.[0]?.text ?? "{}";
  if (json.result?.isError) throw new Error(`${name}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function main() {
  const projects = await call("list_projects", {});
  const list: Array<{ id: string; name: string }> = projects.projects ?? projects;
  const project = list.find((p) => p.id === projectArg) ?? list.find((p) => p.name?.toLowerCase() === projectArg.toLowerCase());
  if (!project) {
    console.error(`no project '${projectArg}' — available: ${list.map((p) => p.name).join(", ")}`);
    process.exit(1);
  }

  // A used directory is a trap, twice over: re-checkout would silently
  // overwrite local edits, and files since deleted from the mirror would
  // linger on disk for propose-changes to resurrect as NEW.
  if (existsSync(dirArg) && readdirSync(dirArg).length) {
    console.error(`'${dirArg}' is not empty. Propose your changes from it first, then check out into a FRESH directory.`);
    process.exit(1);
  }

  const map = await call("get_code_map", { projectId: project.id });
  if (!map.files?.length) {
    console.error("the mirror is empty — nothing to check out");
    process.exit(1);
  }
  if (map.warning) console.warn(`WARNING: ${map.warning}`);

  // Refuse before writing anything: server-supplied paths must be sane, and
  // case-colliding paths (Case.md vs case.md) cannot coexist on a
  // case-insensitive filesystem — last write would silently win for BOTH the
  // working copy and the base, and propose would then report a phantom
  // deletion of the loser.
  const byLower = new Map<string, string>();
  for (const f of map.files as Array<{ path: string }>) {
    const segments = f.path.split("/");
    if (f.path.includes("\\") || /^[A-Za-z]:/.test(f.path) || f.path.startsWith("/") || segments.some((s) => s === ".." || s === "." || !s)) {
      console.error(`refusing suspicious server-supplied path '${f.path}'`);
      process.exit(1);
    }
    const prev = byLower.get(f.path.toLowerCase());
    if (prev && prev !== f.path) {
      console.error(`the mirror holds case-colliding paths '${prev}' and '${f.path}', which cannot coexist on this filesystem. Fix the mirror first (sync_code deletes one of them).`);
      process.exit(1);
    }
    byLower.set(f.path.toLowerCase(), f.path);
  }

  const manifest: Record<string, string> = {};
  let bytes = 0;
  for (const f of map.files as Array<{ path: string; hash: string }>) {
    // read_code windows large files; loop until the whole thing has arrived.
    let content = "";
    let offset = 0;
    for (;;) {
      const r = await call("read_code", { projectId: project.id, path: f.path, offset, maxChars: 200_000 });
      if (typeof r.content !== "string") throw new Error(`read_code returned no content for '${f.path}'`);
      content += r.content;
      if (!r.truncated) break;
      // Guard against protocol drift: truncated without an advancing
      // nextOffset would refetch the same window forever.
      if (typeof r.nextOffset !== "number" || r.nextOffset <= offset) {
        throw new Error(`read_code says '${f.path}' is truncated but gave no advancing nextOffset — refusing to loop forever`);
      }
      offset = r.nextOffset;
    }
    // The manifest hash is only worth recording if it is TRUE of what we
    // wrote: a sync landing mid-checkout (or between two windows of one file)
    // would otherwise leave a base whose recorded hash silently lies.
    const got = createHash("sha256").update(content).digest("hex");
    if (got !== f.hash) {
      throw new Error(`'${f.path}' changed in the mirror while being checked out (hash mismatch) — re-run the checkout`);
    }
    // Two copies: the working file the agent edits, and the pristine base that
    // propose-changes diffs against without another network round trip.
    for (const target of [join(dirArg, f.path), join(dirArg, ".openvault", "base", f.path)]) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, "utf8");
    }
    manifest[f.path] = f.hash;
    bytes += content.length;
  }

  mkdirSync(join(dirArg, ".openvault"), { recursive: true });
  writeFileSync(
    join(dirArg, ".openvault", "checkout.json"),
    JSON.stringify(
      {
        vault: VAULT,
        projectId: project.id,
        projectName: project.name,
        ref: map.mirrorRef ?? null,
        checkedOutAt: new Date().toISOString(),
        files: manifest,
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log(`${map.files.length} file(s), ${(bytes / 1024).toFixed(0)} KB -> ${dirArg}`);
  console.log(`mirror ref: ${map.mirrorRef ?? "(none recorded)"}${map.consistent ? "" : " — INCONSISTENT: this checkout may mix commits"}`);
  console.log(`edit normally, then: npx tsx scripts/propose-changes.ts "${dirArg}" --reason "why"`);
}

main().catch((err) => {
  console.error(String(err?.message ?? err));
  // checkout.json is written last, so a partial tree has no manifest and
  // propose-changes will refuse it — but it still LOOKS complete to an agent
  // pointed at the directory. Say so.
  console.error("checkout incomplete — delete the target directory and retry.");
  process.exit(1);
});

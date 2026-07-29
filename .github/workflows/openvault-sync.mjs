// Syncs the checked-out tree to this project's OpenVault code mirror.
//
// Whole-tree, not changed-files-only: a mirror built from per-commit deltas
// drifts into a mix of refs that never coexisted. Sending the full manifest
// every run means the mirror is always exactly this commit, and files deleted
// in the repo are deleted here too.
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// Strip a BOM and surrounding whitespace. Setting a secret by piping a string
// on Windows PowerShell prepends U+FEFF, which makes the Authorization header
// throw "Cannot convert argument to a ByteString" — an error that names an
// index in an internal string and says nothing about the real cause.
const clean = (v) => (v ?? "").replace(/^﻿/, "").trim();
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
const TEXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|txt|css|scss|html|yml|yaml|toml|py|rb|go|rs|java|kt|swift|sh|sql|prisma|graphql)$/i;

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

const paths = sh("git ls-files")
  .split("\n")
  .map((p) => p.trim())
  .filter((p) => p && TEXT.test(p));

const files = [];
for (const p of paths) {
  try {
    const content = readFileSync(p, "utf8");
    if (content.length <= MAX_CHARS && !content.includes("\u0000")) files.push({ path: p, content });
  } catch {
    /* unreadable — skip */
  }
}

// Skip files the mirror already holds byte-identically; the manifest below
// still stamps them with this ref, so the mirror stays one consistent commit.
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const map = await call("get_code_map", { projectId: PROJECT });
const known = new Map((map.files ?? []).map((f) => [f.path, f.hash]));
const changed = files.filter((f) => known.get(f.path) !== sha256(f.content));

const batches = [];
let cur = [];
let bytes = 0;
for (const f of changed) {
  const cost = f.content.length + f.path.length + 32;
  if (cur.length && (cur.length >= BATCH_FILES || bytes + cost > BATCH_BYTES)) {
    batches.push(cur);
    cur = [];
    bytes = 0;
  }
  cur.push(f);
  bytes += cost;
}
if (cur.length) batches.push(cur);

let synced = 0;
for (let i = 0; i < batches.length; i++) {
  const r = await call("sync_code", { projectId: PROJECT, ref, files: batches[i], actor: "ci" });
  synced += r.synced ?? 0;
  console.log(`batch ${i + 1}/${batches.length}: ${r.synced ?? 0} file(s)`);
}

// The manifest is the whole commit: anything mirrored but absent was deleted,
// and every path in it is stamped with this ref.
const done = await call("sync_code", {
  projectId: PROJECT,
  ref,
  files: [],
  manifest: files.map((f) => f.path),
  actor: "ci",
});
console.log(`mirror now at ${ref}: ${files.length} file(s), ${synced} updated, ${done.pruned ?? 0} removed`);

const after = await call("get_code_map", { projectId: PROJECT });
console.log(`consistent: ${after.consistent}${after.warning ? " — " + after.warning : ""}`);
if (!after.consistent) process.exit(1);

// Turn the edits in a checkout-mirror working copy into OpenVault suggestions.
//
//   npx tsx scripts/propose-changes.ts <workingCopyDir> --reason "why (10+ chars)" [--title "..."] [--dry-run]
//
// Diffs every file against the pristine copy under .openvault/base, converts
// each changed file into content-anchored edits (editsFromContents widens
// context until every anchor is unambiguous), and files one suggest_change per
// file. New text files are proposed whole. Nothing here writes the mirror —
// the owner reviews with review_suggestion, and approval hands THEM the result
// to apply in their real checkout.
//
// Edits travel as JSON in a request body, never through a shell — so nothing
// mangles backticks, quotes, or anything else source code is full of.
//
// The server re-validates every anchor against the mirror as it stands NOW; if
// someone changed a file after this checkout, that proposal is refused with
// the reason, which is staleness detection working, not a bug.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { editsFromContents, MAX_EDIT_CHARS } from "../src/lib/suggest";

const argv = process.argv.slice(2);
const dir = argv[0];
const flagValue = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const dryRun = argv.includes("--dry-run");
const reason = flagValue("--reason");
const title = flagValue("--title");
if (!dir || dir.startsWith("--") || !reason || reason.trim().length < 10) {
  console.error('usage: npx tsx scripts/propose-changes.ts <workingCopyDir> --reason "why (10+ chars)" [--title "..."] [--dry-run]');
  process.exit(1);
}

type Manifest = { vault: string; projectId: string; projectName: string; files: Record<string, string> };
const meta: Manifest = JSON.parse(readFileSync(join(dir, ".openvault", "checkout.json"), "utf8"));
const TOKEN = (process.env.OPENVAULT_TOKEN ?? "").replace(/^﻿/, "").trim();

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const res = await fetch(`${meta.vault}/api/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
  const text = json.result?.content?.[0]?.text ?? "{}";
  if (json.result?.isError) throw new Error(text.slice(0, 300));
  return JSON.parse(text);
}

// Same text-type filter the mirror itself uses — anything else was never
// mirrored and cannot be proposed.
const TEXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|txt|css|scss|html|yml|yaml|toml|py|rb|go|rs|java|kt|swift|sh|sql|prisma|graphql)$/i;
const norm = (s: string) => s.replace(/\r\n/g, "\n");

const walk = (root: string): string[] =>
  readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => relative(root, join((d as unknown as { parentPath?: string; path: string }).parentPath ?? (d as unknown as { path: string }).path, d.name)).replace(/\\/g, "/"))
    .filter((p) => !p.startsWith(".openvault/"));

async function main() {
const working = new Set(walk(dir));
const basePaths = new Set(Object.keys(meta.files));
const results: Array<{ path: string; outcome: string }> = [];
let filed = 0;

for (const path of [...new Set([...working, ...basePaths])].sort()) {
  const inBase = basePaths.has(path);
  const inWork = working.has(path);
  try {
    if (inBase && !inWork) {
      results.push({ path, outcome: "SKIP — deleted locally; deletion proposals aren't supported yet, tell the owner in a note" });
      continue;
    }
    if (!inBase && inWork) {
      if (!TEXT.test(path)) continue; // never mirrored, not proposable
      const content = norm(readFileSync(join(dir, path), "utf8"));
      if (!content.trim()) {
        results.push({ path, outcome: "SKIP — empty file" });
        continue;
      }
      if (content.length > MAX_EDIT_CHARS) {
        results.push({ path, outcome: `SKIP — new file over ${MAX_EDIT_CHARS} chars; sync it or split it` });
        continue;
      }
      if (dryRun) {
        results.push({ path, outcome: "would propose as a NEW file" });
        continue;
      }
      const r = await call("suggest_change", {
        projectId: meta.projectId,
        path,
        edits: [{ before: "", after: content }],
        reason,
        title: title ? `${title}: ${path}` : `New file ${path}`,
      });
      filed++;
      results.push({ path, outcome: `NEW file -> suggestion ${r.suggestionId}` });
      continue;
    }
    const base = norm(readFileSync(join(dir, ".openvault", "base", path), "utf8"));
    const now = norm(readFileSync(join(dir, path), "utf8"));
    if (base === now) continue;
    const plan = editsFromContents(base, now);
    if (!plan.ok) {
      results.push({ path, outcome: `SKIP — ${plan.reason}` });
      continue;
    }
    if (dryRun) {
      results.push({ path, outcome: `would propose ${plan.edits.length} edit(s)` });
      continue;
    }
    const r = await call("suggest_change", { projectId: meta.projectId, path, edits: plan.edits, reason, ...(title ? { title: `${title}: ${path}` } : {}) });
    filed++;
    results.push({ path, outcome: `${plan.edits.length} edit(s) -> suggestion ${r.suggestionId}` });
  } catch (err) {
    results.push({ path, outcome: `ERROR — ${String((err as Error).message ?? err).slice(0, 200)}` });
  }
}

if (!results.length) {
  console.log("no changes — the working copy matches the checkout base");
} else {
  for (const r of results) console.log(`  ${r.path}: ${r.outcome}`);
  console.log(`\n${filed} suggestion(s) filed${dryRun ? " (dry run — nothing sent)" : ""} against '${meta.projectName}' at ${meta.vault}`);
  if (filed) console.log("the owner reviews with list_suggestions / review_suggestion; approval hands them the result to apply in their own checkout.");
}
}

main().catch((err) => {
  console.error(String(err?.message ?? err));
  process.exit(1);
});

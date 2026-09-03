import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

// Same content hash the server stores, so "unchanged" can be decided locally.
const hashOf = (content: string) => createHash("sha256").update(content).digest("hex");

// Sync any repo's source into a vault project's code mirror, so agents answer
// "how does X work" by reading the code THROUGH the vault — no filesystem
// access, no git pull, no pre-digested notes.
//
//   npx tsx scripts/sync-repo.ts <dir> <projectName> [vaultUrl]
//
// Uses `git ls-files` when the dir is a git repo (respects .gitignore);
// otherwise walks the tree with sane excludes. Set OPENVAULT_TOKEN for an
// authenticated vault.

const [dir, projectName, vaultArg] = process.argv.slice(2);
const VAULT = vaultArg || "http://localhost:6900";
// Files above this are stored chunked by the server, not skipped; this is only
// a sanity bound against a runaway generated artifact.
const MAX_CHARS = 4_000_000;
const MAX_FILES = 2000;
// Two independent batch limits. The server caps a call at 100 files, and the
// deployed host (Vercel) rejects request bodies over 4.5 MB — so a batch of
// large files can bust the byte limit long before the file limit. Batching on
// count alone produced a 413 that looks like "the sync silently did nothing".
const BATCH_FILES = 100;
const BATCH_BYTES = 1_800_000;

const EXCLUDE_DIRS = new Set([
  "node_modules", ".git", "__pycache__", "models", "dist", ".next", "storage",
  "backups", ".claude", "lumina_memory", "worktrees", ".vercel",
]);
const EXCLUDE_DIR_PATTERNS = [/env$/i, /^venv/i, /^tts_model/i, /^\.venv/i];
const TEXT_EXT = new Set([
  ".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".json", ".md", ".txt",
  ".html", ".css", ".toml", ".yaml", ".yml", ".cfg", ".ini", ".bat", ".sh",
  ".sql", ".prisma", ".env.example",
]);

function isTextFile(p: string): boolean {
  const base = path.basename(p).toLowerCase();
  if (base === ".env" || base.endsWith(".env")) return false; // never mirror secrets
  return TEXT_EXT.has(path.extname(base)) || base === "dockerfile" || base === ".gitignore";
}

function walk(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(root, rel))) {
    const relPath = rel ? `${rel}/${entry}` : entry;
    const full = path.join(root, relPath);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry) || EXCLUDE_DIR_PATTERNS.some((re) => re.test(entry))) continue;
      out.push(...walk(root, relPath));
    } else if (isTextFile(relPath)) {
      out.push(relPath);
    }
  }
  return out;
}

type OutFile = { path: string; content: string; baseHash?: string };

async function main() {
  if (!dir || !projectName) {
    console.error("usage: npx tsx scripts/sync-repo.ts <dir> <projectName> [vaultUrl]");
    process.exit(1);
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (process.env.OPENVAULT_TOKEN) headers.authorization = `Bearer ${process.env.OPENVAULT_TOKEN}`;
  const rpc = async (name: string, args: unknown) => {
    // An unreachable vault is the NORMAL case when this runs from a commit
    // hook: most of the time the server is simply not started. Say so in one
    // line and exit clean, instead of letting a raw fetch error object land in
    // the hook log where it reads like the commit went wrong.
    let res: Response;
    try {
      res = await fetch(`${VAULT}/api/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      });
    } catch {
      console.log(`vault not reachable at ${VAULT} — skipping sync (nothing was changed)`);
      process.exit(0);
    }
    const out = (await res.json()) as { result?: { content?: Array<{ text: string }>; isError?: boolean } };
    const text = out.result?.content?.[0]?.text ?? "{}";
    if (out.result?.isError) throw new Error(text);
    return JSON.parse(text);
  };

  const projects = (await rpc("list_projects", {})) as Array<{ id: string; name: string }>;
  const project = projects.find((p) => p.name === projectName);
  if (!project) {
    console.error(`no vault project named "${projectName}" (have: ${projects.map((p) => p.name).join(", ")})`);
    process.exit(1);
  }

  const isGit = existsSync(path.join(dir, ".git"));
  let ref: string | undefined;
  let paths: string[];
  if (isGit) {
    const run = (cmd: string) => execSync(cmd, { cwd: dir, encoding: "utf8" }).trim();
    ref = `${run("git rev-parse --abbrev-ref HEAD")} @ ${run("git rev-parse --short HEAD")}`;
    paths = run("git ls-files").split("\n").map((p) => p.trim()).filter((p) => p && isTextFile(p));
  } else {
    paths = walk(dir);
  }
  if (paths.length > MAX_FILES) {
    console.log(`capping at ${MAX_FILES} of ${paths.length} files (prefer a git repo with .gitignore for control)`);
    paths = paths.slice(0, MAX_FILES);
  }

  const files: OutFile[] = [];
  for (const p of paths) {
    try {
      const content = readFileSync(path.join(dir, p), "utf8");
      if (content.length <= MAX_CHARS && !content.includes("\u0000")) files.push({ path: p, content });
    } catch {
      /* unreadable — skip */
    }
  }

  // Only overwrite mirror content that ALREADY EXISTS IN GIT.
  //
  // Sending the mirror's current hash as baseHash would be theatre — it just
  // says "replace whatever is there". The real question is whether what is
  // there can be recovered if we replace it. If the mirror holds a version
  // that git has never seen, it is mirror-only work (someone authoring without
  // a checkout) and this push would destroy it, which is precisely how a day's
  // CSS was lost. Git blob ids answer that exactly: hash the mirror's content
  // the way git would and ask the repo whether it knows that blob.
  const mapRes = (await rpc("get_code_map", { projectId: project.id })) as {
    files?: Array<{ path: string; hash: string }>;
  };
  const mirrorHash = new Map((mapRes.files ?? []).map((f) => [f.path, f.hash]));

  const gitBlobId = (content: string) => {
    const buf = Buffer.from(content, "utf8");
    return createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
  };
  const knownBlob = (content: string) => {
    try {
      execSync(`git cat-file -e ${gitBlobId(content)}`, { cwd: dir, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  const inGitHistory = (content: string) => {
    if (!isGit) return false;
    // A Windows checkout holds CRLF on disk while git stores the blob with LF,
    // so the raw bytes miss and every file looks like unpushed work. Check the
    // normalized form too — matching either means git has this content.
    return knownBlob(content) || knownBlob(content.replace(/\r\n/g, "\n"));
  };

  const unchanged: string[] = [];
  const protectedPaths: Array<{ path: string; by: string | null; ref: string | null }> = [];
  const toSend: OutFile[] = [];
  for (const f of files) {
    const current = mirrorHash.get(f.path);
    if (!current) {
      toSend.push(f); // not in the mirror yet
      continue;
    }
    if (current === hashOf(f.content)) {
      unchanged.push(f.path); // identical — sending it would be pure waste
      continue;
    }
    // The mirror differs. Fetch what it holds and decide if losing it is safe.
    const held = (await rpc("read_code", { projectId: project.id, path: f.path, maxChars: MAX_CHARS })) as {
      content: string;
      syncedBy: string | null;
      ref: string | null;
      truncated?: boolean;
    };
    if (!held.truncated && !inGitHistory(held.content)) {
      protectedPaths.push({ path: f.path, by: held.syncedBy, ref: held.ref });
      continue;
    }
    f.baseHash = current; // safe to fast-forward: git still has this version
    toSend.push(f);
  }

  if (unchanged.length) console.log(`  ${unchanged.length} file(s) already identical in the mirror — not resent`);
  if (protectedPaths.length) {
    console.error(`\n!! ${protectedPaths.length} file(s) SKIPPED to protect work that is not in git:`);
    for (const p of protectedPaths) {
      console.error(`   ${p.path}  (mirror version by ${p.by ?? "unknown"}${p.ref ? `, ref ${p.ref}` : ""})`);
    }
    console.error("   read_code those paths, merge into your working copy, commit, then re-run.");
  }
  // The manifest is the COMPLETE path list of the commit, so capture it before
  // `files` is narrowed to just the ones being sent.
  const allPaths = files.map((f) => f.path);
  files.length = 0;
  files.push(...toSend);
  if (!files.length) {
    console.log(`${projectName}: nothing to sync${protectedPaths.length ? ` (${protectedPaths.length} protected)` : ""}`);
    if (protectedPaths.length) process.exit(2);
    return;
  }

  // Pack batches under BOTH limits: file count and payload bytes.
  const batches: OutFile[][] = [];
  let current: OutFile[] = [];
  let bytes = 0;
  for (const f of files) {
    const cost = f.content.length + f.path.length + 32; // ~JSON overhead per entry
    if (current.length && (current.length >= BATCH_FILES || bytes + cost > BATCH_BYTES)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(f);
    bytes += cost;
  }
  if (current.length) batches.push(current);

  let synced = 0;
  let batchNo = 0;
  const conflicted: Array<{ path: string; currentSyncedBy: string | null; currentRef: string | null }> = [];
  for (const batch of batches) {
    batchNo++;
    const kb = Math.round(batch.reduce((s, f) => s + f.content.length, 0) / 1024);
    const r = (await rpc("sync_code", {
      projectId: project.id,
      ref,
      files: batch,
      actor: "sync-repo",
    })) as {
      synced: number;
      skipped: Array<{ path: string; reason: string }>;
      conflicts?: Array<{ path: string; currentSyncedBy: string | null; currentRef: string | null }>;
    };
    synced += r.synced;
    conflicted.push(...(r.conflicts ?? []));
    console.log(`  batch ${batchNo}/${batches.length}: ${r.synced}/${batch.length} files, ${kb} KB`);
    for (const s of r.skipped ?? []) console.log(`  skipped ${s.path}: ${s.reason}`);
  }
  const totalKb = Math.round(files.reduce((s, f) => s + f.content.length, 0) / 1024);
  console.log(`${projectName}: synced ${synced}/${files.length} files (${totalKb} KB)${ref ? ` @ ${ref}` : ""}`);

  // Stamp the ref across the whole commit, not just the files that changed.
  //
  // Skipping unchanged files saves real bandwidth, but it left them carrying
  // the ref of whenever they last changed. get_code_map judges consistency by
  // counting distinct refs, so a clean sync where every file was byte-identical
  // to HEAD still reported `consistent: false` and warned agents the tree "may
  // be versions that never coexisted". A staleness warning that fires when
  // nothing is stale is worse than none: it trains everyone to ignore the
  // warning on a project where the drift is real.
  //
  // The server already handles this — a manifest stamps the ref on every path
  // in it and prunes anything absent. The script simply never sent one.
  //
  // Not sent when files were protected: those paths hold mirror content that is
  // not in git, so the mirror genuinely is not equal to one commit and saying
  // otherwise would be the same lie in the opposite direction.
  if (!conflicted.length && !protectedPaths.length) {
    const m = (await rpc("sync_code", {
      projectId: project.id,
      ref,
      files: [],
      manifest: allPaths,
      actor: "sync-repo",
    })) as { pruned?: string[] };
    const pruned = m.pruned?.length ?? 0;
    console.log(`  manifest: ${allPaths.length} paths stamped @ ${ref}${pruned ? `, ${pruned} pruned` : ""}`);
  } else {
    console.log("  manifest NOT sent — mirror still spans refs (see the warnings above)");
  }

  if (conflicted.length) {
    // Loud and non-zero: a silent "success" here is what let a day's work be
    // overwritten before anyone noticed.
    console.error(`\n!! ${conflicted.length} file(s) NOT synced — someone changed them in the mirror after you last read them:`);
    for (const c of conflicted) {
      console.error(`   ${c.path}  (currently ${c.currentSyncedBy ?? "unknown"}${c.currentRef ? `, ref ${c.currentRef}` : ""})`);
    }
    console.error("   Nothing was lost. Read those paths with read_code, merge, and re-run.");
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

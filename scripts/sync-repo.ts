import { execSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

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
const MAX_CHARS = 200_000;
const MAX_FILES = 500;

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

async function main() {
  if (!dir || !projectName) {
    console.error("usage: npx tsx scripts/sync-repo.ts <dir> <projectName> [vaultUrl]");
    process.exit(1);
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (process.env.OPENVAULT_TOKEN) headers.authorization = `Bearer ${process.env.OPENVAULT_TOKEN}`;
  const rpc = async (name: string, args: unknown) => {
    const res = await fetch(`${VAULT}/api/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
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

  const files: Array<{ path: string; content: string }> = [];
  for (const p of paths) {
    try {
      const content = readFileSync(path.join(dir, p), "utf8");
      if (content.length <= MAX_CHARS && !content.includes("\u0000")) files.push({ path: p, content });
    } catch {
      /* unreadable — skip */
    }
  }

  let synced = 0;
  for (let i = 0; i < files.length; i += 80) {
    const r = (await rpc("sync_code", {
      projectId: project.id,
      ref,
      files: files.slice(i, i + 80),
      actor: "sync-repo",
    })) as { synced: number; skipped: Array<{ path: string; reason: string }> };
    synced += r.synced;
    for (const s of r.skipped ?? []) console.log(`skipped ${s.path}: ${s.reason}`);
  }
  console.log(`${projectName}: synced ${synced}/${files.length} files${ref ? ` @ ${ref}` : ""}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

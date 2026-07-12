import crypto from "node:crypto";

// Shared code layer: agents push file snapshots (sync_code) and declare what
// they're working on (announce_work) so every connected agent sees the same
// code and each other's in-flight changes — no repeated git pulls, no
// stepping on the same files blind.

export const MAX_SYNC_FILES = 100; // files per sync_code call
export const MAX_FILE_CHARS = 200_000; // per-file content cap (~200 KB)
export const WORK_STATUSES = ["planning", "in_progress", "in_review", "done", "abandoned"] as const;
// Statuses that count as "someone is actively on this" for overlap warnings
// and the active-work board. in_review is still active: the code isn't merged.
export const ACTIVE_WORK_STATUSES = ["planning", "in_progress", "in_review"] as const;

// A safe repo-relative path: forward slashes, no traversal, no absolute paths,
// no exotic characters. Windows separators are normalized before validation.
// Brackets/parens/plus are framework-standard (Next.js "[id]" and "(group)",
// SvelteKit "+page.svelte", parallel-route "@modal") — allowed; traversal
// safety comes from the separate ".." segment check, not the charset.
const SEGMENT_RE = /^[A-Za-z0-9._@+()[\]-]+$/;

export function normalizeRepoPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

export function isValidRepoPath(path: string): boolean {
  const p = normalizeRepoPath(path);
  if (!p || p.length > 400 || p.startsWith("/") || /^[A-Za-z]:/.test(p)) return false;
  const segments = p.split("/");
  return segments.every((s) => s.length > 0 && s !== ".." && s !== "." && SEGMENT_RE.test(s));
}

export function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

// Paths two work intents both touch — the conflict signal announce_work returns.
export function pathOverlap(a: string[], b: string[]): string[] {
  const set = new Set(b.map(normalizeRepoPath));
  return a.map(normalizeRepoPath).filter((p) => set.has(p));
}

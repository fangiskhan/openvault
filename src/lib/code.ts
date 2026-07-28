import crypto from "node:crypto";

// Shared code layer: agents push file snapshots (sync_code) and declare what
// they're working on (announce_work) so every connected agent sees the same
// code and each other's in-flight changes — no repeated git pulls, no
// stepping on the same files blind.

export const MAX_SYNC_FILES = 100; // files per sync_code call
// Chunk size, not a file-size limit: a file longer than this is stored as
// several rows and reassembled on read. It used to be a hard cap, which left a
// permanent hole in the mirror at exactly a project's biggest modules — the
// files an agent most needs to read.
export const MAX_FILE_CHARS = 200_000;
// A sanity bound on one file so a runaway generated artifact can't fill the
// vault. Well above any hand-written module.
export const MAX_TOTAL_FILE_CHARS = 4_000_000;

// How much of a file read_code hands back at once. Storing a 1.25 MB module is
// now fine; returning it whole is not — that is ~300k tokens and would swamp
// the caller's context. So reads are windowed and the response says how to get
// the next slice.
export const READ_WINDOW = 60_000;
export const READ_WINDOW_MAX = 200_000;

// Split a file into storable chunks. Ordinary files yield exactly one.
export function chunkContent(content: string, size = MAX_FILE_CHARS): string[] {
  if (content.length <= size) return [content];
  const out: string[] = [];
  for (let i = 0; i < content.length; i += size) out.push(content.slice(i, i + size));
  return out;
}
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

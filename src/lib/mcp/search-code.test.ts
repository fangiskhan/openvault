import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { unlinkSync } from "node:fs";
import path from "node:path";

// DB-backed tests for search_code — grep over a project's mirrored source.
// Runs against a throwaway SQLite file so it can never touch dev.db.
//
// The load-bearing case is the chunk boundary. A file over the per-chunk cap is
// stored as several CodeFile rows, so a match straddling two chunks exists in
// NEITHER row on its own. Verified against the live mirror while writing this:
// a probe spanning package-lock.json's boundary returned 0 rows from a per-row
// `contains` and 1 correct hit from search_code. That is the regression this
// file exists to hold.

const TEST_DB = path.join(process.cwd(), "prisma", "search-code-test.db");
process.env.DATABASE_URL = `file:./search-code-test.db`;

type Tools = typeof import("./tools");
let toolMap: Tools["toolMap"];
let prisma: (typeof import("../db"))["prisma"];
let projectId: string;

type Hit = { path: string; line: number; text: string };
type Result = {
  matches: Hit[];
  filesMatched: number;
  totalMatches: number;
  truncated: boolean;
  hint?: string;
  warning?: string;
  note?: string;
};

const search = (args: Record<string, unknown>) =>
  toolMap.get("search_code")!.handler({ projectId, ...args }) as Promise<Result>;

beforeAll(async () => {
  try {
    unlinkSync(TEST_DB);
  } catch {
    /* first run, or a handle still held — the push below is idempotent */
  }
  execSync("npx prisma db push --skip-generate", {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: `file:./search-code-test.db` },
    stdio: "pipe",
  });
  ({ toolMap } = await import("./tools"));
  ({ prisma } = await import("../db"));

  const project = await prisma.project.create({ data: { slug: "grep-test", name: "Grep Test" } });
  projectId = project.id;

  const file = (p: string, content: string, part = 0, parts = 1) => ({
    projectId,
    path: p,
    part,
    parts,
    content,
    hash: "x".repeat(64),
    size: content.length,
  });

  await prisma.codeFile.createMany({
    data: [
      file("src/lib/auth.ts", 'export function secretsRequired() {\n  return NODE_ENV === "production";\n}\n'),
      file("src/app/api/ingest/route.ts", "import { secretsRequired } from '@/lib/auth';\n// SECRETSREQUIRED in caps, for the case tests\n"),
      file("README.md", "# Docs\nNothing relevant here.\n"),
      // A two-part file whose needle straddles the boundary: "STRAD" ends part
      // 0 and "DLE" begins part 1, so neither row contains "STRADDLE".
      file("src/big.ts", "line one\nline two ends with STRAD", 0, 2),
      file("src/big.ts", "DLE and continues\nlast line\n", 1, 2),
    ],
  });
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  try {
    unlinkSync(TEST_DB);
  } catch {
    /* windows may hold the handle briefly; a stray test db is harmless */
  }
});

describe("search_code", () => {
  it("finds a literal string and reports path and 1-based line number", async () => {
    const r = await search({ query: "secretsRequired" });
    expect(r.filesMatched).toBe(2);
    const auth = r.matches.find((m) => m.path === "src/lib/auth.ts");
    expect(auth?.line).toBe(1);
    expect(auth?.text).toContain("export function secretsRequired");
  });

  it("is case-insensitive by default", async () => {
    const lower = await search({ query: "secretsrequired" });
    const upper = await search({ query: "SECRETSREQUIRED" });
    expect(lower.totalMatches).toBeGreaterThan(0);
    expect(upper.totalMatches).toBe(lower.totalMatches);
  });

  it("caseSensitive:true respects case", async () => {
    const r = await search({ query: "SECRETSREQUIRED", caseSensitive: true });
    // Only the literal all-caps comment, not the camelCase identifier.
    expect(r.filesMatched).toBe(1);
    expect(r.matches[0].path).toBe("src/app/api/ingest/route.ts");
  });

  it("matches across a chunk boundary — the case a per-row scan cannot see", async () => {
    // Neither stored row contains "STRADDLE"; only the rejoined file does.
    const rows = await prisma.codeFile.count({ where: { content: { contains: "STRADDLE" } } });
    expect(rows).toBe(0);

    const r = await search({ query: "STRADDLE" });
    expect(r.filesMatched).toBe(1);
    expect(r.matches[0].path).toBe("src/big.ts");
    // Line 2 of the rejoined file, not of either chunk.
    expect(r.matches[0].line).toBe(2);
  });

  it("pathPrefix narrows the scan", async () => {
    const all = await search({ query: "secretsRequired" });
    const scoped = await search({ query: "secretsRequired", pathPrefix: "src/app/" });
    expect(all.filesMatched).toBe(2);
    expect(scoped.filesMatched).toBe(1);
    expect(scoped.matches.every((m) => m.path.startsWith("src/app/"))).toBe(true);
  });

  it("reports truncation instead of capping silently", async () => {
    const r = await search({ query: "line", limit: 1 });
    expect(r.matches).toHaveLength(1);
    expect(r.totalMatches).toBeGreaterThan(1);
    expect(r.truncated).toBe(true);
    expect(r.hint).toMatch(/showing 1 of \d+/);
  });

  it("returns an empty result, not an error, when nothing matches", async () => {
    const r = await search({ query: "zzz-nothing-matches-zzz" });
    expect(r.totalMatches).toBe(0);
    expect(r.matches).toEqual([]);
    expect(r.truncated).toBe(false);
  });

  it("explains an unmatched pathPrefix rather than looking like no results", async () => {
    const r = await search({ query: "line", pathPrefix: "does/not/exist/" });
    expect(r.totalMatches).toBe(0);
    expect(r.note).toContain("does/not/exist/");
  });

  it("rejects an empty query", async () => {
    await expect(search({ query: "   " })).rejects.toThrow(/query is required/);
  });

  it("does not search notes — that is search's job", async () => {
    await prisma.item.create({
      data: { projectId, type: "note", title: "secretsRequired note", body: "secretsRequired appears here too" },
    });
    const r = await search({ query: "secretsRequired" });
    // Still only the two mirrored FILES; the note is not a code hit.
    expect(r.filesMatched).toBe(2);
    expect(r.matches.every((m) => m.path.endsWith(".ts"))).toBe(true);
  });
});

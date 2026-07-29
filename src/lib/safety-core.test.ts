import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { unlinkSync } from "node:fs";
import path from "node:path";

// DB-backed tests for the multi-user safety core: registration → approval →
// token auth, owner-squat protection, and the review gate. Runs against a
// throwaway SQLite file so it can never touch dev.db.

const TEST_DB = path.join(process.cwd(), "prisma", "safety-test.db");
process.env.DATABASE_URL = `file:./safety-test.db`;

// Import AFTER the env is set — src/lib/db instantiates PrismaClient on import.
type Accounts = typeof import("./accounts");
type Tools = typeof import("./mcp/tools");
let accounts: Accounts;
let toolMap: Tools["toolMap"];
let prisma: (typeof import("./db"))["prisma"];

beforeAll(async () => {
  // Fresh DB each run by deleting the file — avoids --force-reset, which
  // Prisma (rightly) refuses when invoked by an AI agent.
  try {
    unlinkSync(TEST_DB);
  } catch {
    /* first run or handle held — push below is idempotent */
  }
  execSync("npx prisma db push --skip-generate", {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: `file:./safety-test.db` },
    stdio: "pipe",
  });
  accounts = await import("./accounts");
  ({ toolMap } = await import("./mcp/tools"));
  ({ prisma } = await import("./db"));
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  try {
    unlinkSync(TEST_DB);
  } catch {
    /* windows may hold the handle briefly; a stray test db is harmless */
  }
});

const ctxOf = (a: { id: string; username: string; role: string; status: string }) => ({ account: a });

describe("registration → approval → token auth", () => {
  it("registers pending, token resolves to the account, approval activates it", async () => {
    const { account, token } = await accounts.registerAccount("alice", "Alice");
    expect(account.status).toBe("pending");
    expect(token).toMatch(/^ovk_/);

    // The token resolves (identity), but MCP rejects non-approved callers —
    // resolveCaller checks status; here we assert the data it relies on.
    const resolved = await accounts.resolveByToken(token);
    expect(resolved?.id).toBe(account.id);
    expect(resolved?.status).toBe("pending");

    const owner = await accounts.getOrCreateOwner();
    const approved = await accounts.approveAccount(account.id, owner);
    expect(approved.status).toBe("approved");
    expect(approved.approvedById).toBe(owner.id);
  });

  it("stores no plaintext token and rejects unknown tokens", async () => {
    const { account, token } = await accounts.registerAccount("bob");
    const row = await prisma.account.findUnique({ where: { id: account.id } });
    expect(row?.tokenHash).toBeTruthy();
    expect(row?.tokenHash).not.toContain(token);
    expect(await accounts.resolveByToken("ovk_" + "0".repeat(48))).toBeNull();
  });

  it("regeneration kills the old token immediately", async () => {
    const { account, token } = await accounts.registerAccount("carol");
    const { token: fresh } = await accounts.regenerateToken(account.id, { username: "owner" });
    expect(await accounts.resolveByToken(token)).toBeNull();
    expect((await accounts.resolveByToken(fresh))?.id).toBe(account.id);
  });
});

describe("owner protection", () => {
  it("reserves the owner username against registration", async () => {
    await expect(accounts.registerAccount(accounts.ownerUsername())).rejects.toThrow(/reserved/);
  });

  it("never adopts a squatted owner name", async () => {
    // Simulate a pre-guard squat: an account with the owner name but no owner role.
    await prisma.account.deleteMany({ where: { role: "owner" } });
    const squat = await prisma.account.create({
      data: { username: accounts.ownerUsername(), role: "member", status: "pending", tokenHash: "squat" },
    });
    const owner = await accounts.getOrCreateOwner();
    expect(owner.id).not.toBe(squat.id);
    expect(owner.role).toBe("owner");
    expect(owner.username).not.toBe(squat.username);
    await prisma.account.delete({ where: { id: squat.id } });
  });

  it("refuses to change the owner's role", async () => {
    const owner = await accounts.getOrCreateOwner();
    await expect(accounts.setRole(owner.id, "member", { username: "owner" })).rejects.toThrow(/owner/);
  });
});

describe("review gate", () => {
  it("member cannot self-approve; executive approval marks done with provenance", async () => {
    const project = await prisma.project.create({ data: { name: "T", slug: "t-" + Date.now() } });
    const member = { id: "m1", username: "worker", role: "member", status: "approved" };
    const exec = { id: "e1", username: "boss", role: "executive", status: "approved" };

    const announce = toolMap.get("announce_work")!;
    const update = toolMap.get("update_work")!;
    const review = toolMap.get("review_work")!;

    const w = (await announce.handler(
      { projectId: project.id, intent: "test change", paths: ["src/a.ts"] },
      ctxOf(member),
    )) as { intentId: string };

    await update.handler({ intentId: w.intentId, status: "in_review" }, ctxOf(member));

    // Member self-approving is blocked; member using review_work is blocked.
    await expect(update.handler({ intentId: w.intentId, status: "done" }, ctxOf(member))).rejects.toThrow(/review/);
    await expect(review.handler({ intentId: w.intentId, verdict: "approve" }, ctxOf(member))).rejects.toThrow(/owner\/executive/);

    const verdict = (await review.handler(
      { intentId: w.intentId, verdict: "approve", note: "ok" },
      ctxOf(exec),
    )) as { status: string; reviewedBy: string };
    expect(verdict.status).toBe("done");
    expect(verdict.reviewedBy).toBe("boss");

    // request_changes requires a note and sends work back.
    const w2 = (await announce.handler({ projectId: project.id, intent: "second", paths: [] }, ctxOf(member))) as {
      intentId: string;
    };
    await update.handler({ intentId: w2.intentId, status: "in_review" }, ctxOf(member));
    await expect(review.handler({ intentId: w2.intentId, verdict: "request_changes" }, ctxOf(exec))).rejects.toThrow(/note/);
    const back = (await review.handler(
      { intentId: w2.intentId, verdict: "request_changes", note: "fix it" },
      ctxOf(exec),
    )) as { status: string };
    expect(back.status).toBe("in_progress");
  });

  it("announce_work warns about overlapping active work from other actors", async () => {
    const project = await prisma.project.create({ data: { name: "T2", slug: "t2-" + Date.now() } });
    const announce = toolMap.get("announce_work")!;
    const a = { id: "a", username: "agent-a", role: "member", status: "approved" };
    const b = { id: "b", username: "agent-b", role: "member", status: "approved" };

    await announce.handler({ projectId: project.id, intent: "editing auth", paths: ["src/auth.ts"] }, ctxOf(a));
    const second = (await announce.handler(
      { projectId: project.id, intent: "also auth", paths: ["src\\auth.ts"] },
      ctxOf(b),
    )) as { overlapping: Array<{ actor: string; overlap: string[] }> };

    expect(second.overlapping).toHaveLength(1);
    expect(second.overlapping[0].actor).toBe("agent-a");
    expect(second.overlapping[0].overlap).toEqual(["src/auth.ts"]);
  });
});

// The mirror holds ONE version per path and has no merge algorithm, so every
// guarantee it offers rests on refusing an ambiguous write and on never
// destroying content without archiving it first. None of that was covered.
describe("code mirror: concurrent writes and recoverability", () => {
  type SyncResult = {
    synced: number;
    deleted: number;
    pruned: number;
    conflicts: Array<{ path: string; currentHash: string | null; hint: string }>;
    overwrote: Array<{ path: string }>;
    skipped: Array<{ path: string; reason: string }>;
  };
  const alice = { id: "sa", username: "alice-dev", role: "member", status: "approved" };
  const bob = { id: "sb", username: "bob-dev", role: "member", status: "approved" };

  const newProject = (n: string) => prisma.project.create({ data: { name: n, slug: `${n}-${Date.now()}` } });
  const sync = (args: Record<string, unknown>, who = alice) =>
    toolMap.get("sync_code")!.handler(args, ctxOf(who)) as Promise<SyncResult>;
  const readCode = (projectId: string, path: string) =>
    toolMap.get("read_code")!.handler({ projectId, path }) as Promise<{ content: string; hash: string }>;

  // A file long enough for "line 50" and "line 150" to be genuinely far apart.
  const lines = (edits: Record<number, string> = {}) =>
    Array.from({ length: 200 }, (_, i) => edits[i + 1] ?? `line ${i + 1}`).join("\n");

  it("refuses to replace a mirrored file when no baseHash is sent", async () => {
    const p = await newProject("cas1");
    await sync({ projectId: p.id, files: [{ path: "src/a.ts", content: "v1" }] });

    const second = await sync({ projectId: p.id, files: [{ path: "src/a.ts", content: "v2" }] }, bob);
    expect(second.synced).toBe(0);
    expect(second.conflicts).toHaveLength(1);
    expect(second.conflicts[0].hint).toMatch(/no baseHash/);

    // Refused means refused: the slot still holds v1.
    expect((await readCode(p.id, "src/a.ts")).content).toBe("v1");
  });

  it("accepts the current baseHash, refuses a stale one, and force overrides", async () => {
    const p = await newProject("cas2");
    await sync({ projectId: p.id, files: [{ path: "src/b.ts", content: "v1" }] });
    const v1 = await readCode(p.id, "src/b.ts");

    const ok = await sync({ projectId: p.id, files: [{ path: "src/b.ts", content: "v2", baseHash: v1.hash }] });
    expect(ok.synced).toBe(1);
    expect(ok.overwrote).toHaveLength(1);

    // v1.hash is now stale — someone (us) moved the slot to v2.
    const stale = await sync({ projectId: p.id, files: [{ path: "src/b.ts", content: "v3", baseHash: v1.hash }] }, bob);
    expect(stale.synced).toBe(0);
    expect(stale.conflicts[0].hint).toMatch(/changed this since you read it/);

    const forced = await sync({ projectId: p.id, files: [{ path: "src/b.ts", content: "v3" }], force: true }, bob);
    expect(forced.synced).toBe(1);
    expect((await readCode(p.id, "src/b.ts")).content).toBe("v3");
  });

  it("the line-50 / line-150 case: the later push cannot revert the earlier one", async () => {
    const p = await newProject("cas3");
    const path = "src/app.ts";
    await sync({ projectId: p.id, files: [{ path, content: lines() }] });

    // Both read the same starting version.
    const start = await readCode(p.id, path);

    // Alice edits line 50 and lands first.
    const aliceEdit = await sync(
      { projectId: p.id, files: [{ path, content: lines({ 50: "line 50 — ALICE" }), baseHash: start.hash }] },
      alice,
    );
    expect(aliceEdit.synced).toBe(1);

    // Bob edits line 150 in the copy he read at the start, so his file still
    // carries the ORIGINAL line 50. Sending it whole would revert Alice.
    const bobEdit = await sync(
      { projectId: p.id, files: [{ path, content: lines({ 150: "line 150 — BOB" }), baseHash: start.hash }] },
      bob,
    );
    expect(bobEdit.synced).toBe(0);
    expect(bobEdit.conflicts).toHaveLength(1);

    const after = (await readCode(p.id, path)).content.split("\n");
    expect(after[49]).toBe("line 50 — ALICE"); // survived
    expect(after[149]).toBe("line 150"); // Bob's change was refused, not half-applied
  });

  it("keeps the previous version recoverable after a manifest prune", async () => {
    const p = await newProject("cas4");
    await sync({ projectId: p.id, files: [{ path: "src/keep.ts", content: "kept" }] });
    await sync({ projectId: p.id, files: [{ path: "src/only-in-mirror.ts", content: "written only here" }] });

    // A whole-tree sync whose manifest omits the mirror-only file: exactly what
    // CI sends after an unrelated push. This used to destroy it outright.
    const pruneRun = await sync({
      projectId: p.id,
      ref: "main @ abc123",
      files: [],
      manifest: ["src/keep.ts"],
      force: true,
    });
    expect(pruneRun.pruned).toBe(1);

    const history = (await toolMap.get("get_code_history")!.handler({
      projectId: p.id,
      path: "src/only-in-mirror.ts",
    })) as { current: unknown; versionCount: number; versions: Array<{ preview: string }> };
    expect(history.current).toBeFalsy(); // gone from the mirror
    expect(history.versionCount).toBe(1);
    expect(history.versions[0].preview).toBe("written only here"); // but recoverable
  });

  it("archives explicit deletes too, and reports an invalid delete path", async () => {
    const p = await newProject("cas5");
    await sync({ projectId: p.id, files: [{ path: "src/doomed.ts", content: "bye" }] });

    const run = await sync({ projectId: p.id, files: [], deletes: ["src/doomed.ts", "../escape.ts"] });
    expect(run.deleted).toBe(1);
    expect(run.skipped.some((s) => s.reason.includes("invalid repo path"))).toBe(true);

    const history = (await toolMap.get("get_code_history")!.handler({
      projectId: p.id,
      path: "src/doomed.ts",
    })) as { versionCount: number; versions: Array<{ preview: string }> };
    expect(history.versionCount).toBe(1);
    expect(history.versions[0].preview).toBe("bye");
  });
});

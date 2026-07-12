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

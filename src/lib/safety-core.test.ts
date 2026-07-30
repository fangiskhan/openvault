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

// A tool's description is the only thing an agent reads to decide what that
// tool can do. It is as load-bearing as the handler and drifts silently: the
// suggest_change description still said "exactly one edit" long after
// multi-part creates shipped, and never mentioned deleteFile at all — caught by
// a production tools/list check, not by any test. These pin the contract facts
// an agent would act on.
describe("tool descriptions stay true to their handlers", () => {
  const desc = (name: string) => {
    const t = toolMap.get(name);
    if (!t) throw new Error(`no tool '${name}'`);
    return t.description;
  };

  it("suggest_change advertises all three change types", () => {
    const d = desc("suggest_change");
    expect(d).toMatch(/deleteFile/); // removals exist
    expect(d).toMatch(/several parts/i); // multi-part creates exist
    expect(d).not.toMatch(/exactly one edit/i); // the stale claim that shipped
  });

  it("every schema property an agent must choose is discoverable from the description", () => {
    // deleteFile changes the whole meaning of a call, so it cannot live only in
    // the property schema, which agents often skim past.
    const t = toolMap.get("suggest_change")!;
    const props = Object.keys((t.inputSchema as { properties: Record<string, unknown> }).properties);
    expect(props).toContain("deleteFile");
    expect(t.description).toContain("deleteFile");
  });

  it("sync_code points at suggest_change instead of being the default", () => {
    // The tool an agent reaches for when it wants to "just fix it" must name
    // the route that actually delivers work when it cannot push.
    expect(desc("sync_code")).toMatch(/suggest_change/);
  });

  it("the replica refusal names the suggestion route, not just a pull request", async () => {
    const p = await prisma.project.create({ data: { name: "DescRefusal", slug: "desc-refusal-" + Date.now() } });
    await toolMap.get("sync_code")!.handler(
      { projectId: p.id, files: [{ path: "src/x.ts", content: "x" }] },
      ctxOf({ id: "o1", username: "owner-x", role: "owner", status: "approved" }),
    );
    const ci = await accounts.registerAccount("refusal-ci");
    await accounts.approveAccount(ci.account.id, await accounts.getOrCreateOwner());
    await toolMap.get("set_mirror_mode")!.handler(
      { projectId: p.id, mode: "replica", writer: "refusal-ci" },
      ctxOf({ id: "e1", username: "boss", role: "executive", status: "approved" }),
    );
    await expect(
      toolMap.get("sync_code")!.handler(
        { projectId: p.id, files: [{ path: "src/x.ts", content: "y" }] },
        ctxOf({ id: "m1", username: "outsider", role: "member", status: "approved" }),
      ),
    ).rejects.toThrow(/suggest_change/);
    await prisma.project.delete({ where: { id: p.id } });
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

  it("tells the refused writer exactly what changed, as before/after snippets", async () => {
    const p = await newProject("cas6");
    const path = "services/ai_service.py";
    const original = [
      "def get_llm_response(messages_context, image_input):",
      "    if image_input:",
      "        model_to_use = getattr(constants, 'VISION_MODEL')",
      "        last_msg = messages_context[-1]",
      "    return call(model_to_use)",
    ].join("\n");
    await sync({ projectId: p.id, files: [{ path, content: original }] });
    const start = await readCode(p.id, path);

    // Alice pins the vision model and lands first.
    const alicesVersion = original.replace(
      "        model_to_use = getattr(constants, 'VISION_MODEL')",
      "        # FORCE gpt-4o for images, ignoring the config file to prevent crashes\n        model_to_use = \"gpt-4o\"",
    );
    expect((await sync({ projectId: p.id, files: [{ path, content: alicesVersion, baseHash: start.hash }] })).synced).toBe(1);

    // Bob edits a different part of the same file, from the original he read.
    const bobsVersion = original.replace("    return call(model_to_use)", "    return call(model_to_use, retries=3)");
    const refused = await sync({ projectId: p.id, files: [{ path, content: bobsVersion, baseHash: start.hash }] }, bob);
    expect(refused.synced).toBe(0);

    const c = refused.conflicts[0] as unknown as {
      theirChanges?: { changes?: Array<{ before: string; after: string }> };
      hint: string;
    };
    // The refusal carries the actual change, not a coordinate.
    expect(c.theirChanges?.changes?.length).toBe(1);
    expect(c.theirChanges!.changes![0].before).toContain("getattr(constants, 'VISION_MODEL')");
    expect(c.theirChanges!.changes![0].after).toContain('model_to_use = "gpt-4o"');
    expect(c.theirChanges!.changes![0].after).toContain("FORCE gpt-4o for images");
    // Context is included so the snippet can be located after the file moves.
    expect(c.theirChanges!.changes![0].before).toContain("if image_input:");
    expect(c.hint).toMatch(/before\/after snippets/);
  });

  it("lets someone with no write access propose a change, and the owner approve it", async () => {
    const p = await newProject("sugg1");
    const path = "services/ai_service.py";
    const original = [
      "def get_llm_response(messages_context, image_input):",
      "    if image_input:",
      "        model_to_use = getattr(constants, 'VISION_MODEL')",
      "    return call(model_to_use)",
    ].join("\n");
    await sync({ projectId: p.id, files: [{ path, content: original }] });
    // Replica mode: nobody may write the mirror. The suggestion route must
    // still work, because that is the entire point of it.
    // set_mirror_mode verifies the writer is a real, approved account.
    const ciAcct = await accounts.registerAccount("mirror-ci");
    await accounts.approveAccount(ciAcct.account.id, await accounts.getOrCreateOwner());
    await toolMap.get("set_mirror_mode")!.handler(
      { projectId: p.id, mode: "replica", writer: "mirror-ci" },
      ctxOf({ id: "e9", username: "boss", role: "executive", status: "approved" }),
    );

    const suggest = toolMap.get("suggest_change")!;
    const edits = [
      {
        before: "        model_to_use = getattr(constants, 'VISION_MODEL')",
        after: '        # FORCE gpt-4o for images, ignoring config to prevent crashes\n        model_to_use = "gpt-4o"',
      },
    ];
    const made = (await suggest.handler(
      { projectId: p.id, path, edits, reason: "The configured vision model crashes on image input; pin the one that works.", title: "Pin gpt-4o for images" },
      ctxOf(bob),
    )) as { suggestionId: string; noteItemId: string };
    expect(made.suggestionId).toBeTruthy();

    // The reason became a real, searchable note — not a review comment that dies.
    const note = await prisma.item.findUnique({ where: { id: made.noteItemId } });
    expect(note?.body).toContain("crashes on image input");
    expect(note?.createdBy).toBe("bob-dev");

    // A member cannot approve their own suggestion.
    const review = toolMap.get("review_suggestion")!;
    await expect(review.handler({ suggestionId: made.suggestionId, verdict: "approve" }, ctxOf(bob))).rejects.toThrow(/owner\/executive/);
    await expect(review.handler({ suggestionId: made.suggestionId, verdict: "reject" }, ctxOf({ id: "e9", username: "boss", role: "executive", status: "approved" }))).rejects.toThrow(/note/);

    const verdict = (await review.handler(
      { suggestionId: made.suggestionId, verdict: "approve" },
      ctxOf({ id: "e9", username: "boss", role: "executive", status: "approved" }),
    )) as { status: string; reviewedBy: string };
    expect(verdict.status).toBe("approved");
    expect(verdict.reviewedBy).toBe("boss");

    // Approval hands the owner the resulting file — it does NOT touch the mirror.
    const full = (await toolMap.get("get_suggestion")!.handler({ suggestionId: made.suggestionId, withResult: true })) as {
      stillApplies: boolean;
      resultingContent?: string;
    };
    expect(full.stillApplies).toBe(true);
    expect(full.resultingContent).toContain('model_to_use = "gpt-4o"');
    expect((await readCode(p.id, path)).content).toBe(original); // mirror untouched
  });

  it("refuses a suggestion whose anchor text has since changed", async () => {
    const p = await newProject("sugg2");
    const path = "src/config.ts";
    await sync({ projectId: p.id, files: [{ path, content: "export const RETRIES = 1;\nexport const TIMEOUT = 30;" }] });
    const before = await readCode(p.id, path);

    const made = (await toolMap.get("suggest_change")!.handler(
      {
        projectId: p.id,
        path,
        edits: [{ before: "export const RETRIES = 1;", after: "export const RETRIES = 5;" }],
        reason: "One retry is not enough for the flaky upstream API.",
      },
      ctxOf(bob),
    )) as { suggestionId: string };

    // Someone else changes that exact line before anyone reviews it.
    await sync(
      { projectId: p.id, files: [{ path, content: "export const RETRIES = 3;\nexport const TIMEOUT = 30;", baseHash: before.hash }] },
      alice,
    );

    const listed = (await toolMap.get("list_suggestions")!.handler({ projectId: p.id })) as {
      suggestions: Array<{ stillApplies: boolean }>;
    };
    expect(listed.suggestions[0].stillApplies).toBe(false);

    await expect(
      toolMap.get("review_suggestion")!.handler(
        { suggestionId: made.suggestionId, verdict: "approve" },
        ctxOf({ id: "e9", username: "boss", role: "executive", status: "approved" }),
      ),
    ).rejects.toThrow(/no longer fits/);
  });

  it("supports proposing a NEW file, and refuses approval once a different file appears", async () => {
    const p = await newProject("sugg5");
    const suggest = toolMap.get("suggest_change")!;
    const exec = ctxOf({ id: "e9", username: "boss", role: "executive", status: "approved" });

    // Anchored edits against an absent path are still refused — with guidance.
    await expect(
      suggest.handler({ projectId: p.id, path: "src/new.ts", edits: [{ before: "x", after: "y" }], reason: "a reason long enough to pass" }, ctxOf(bob)),
    ).rejects.toThrow(/NEW file/);

    const made = (await suggest.handler(
      { projectId: p.id, path: "src/new.ts", edits: [{ before: "", after: "export const NEW = true;" }], reason: "Adds the flag module the fix needs.", title: "New flag module" },
      ctxOf(bob),
    )) as { suggestionId: string };

    const v = (await toolMap.get("review_suggestion")!.handler({ suggestionId: made.suggestionId, verdict: "approve" }, exec)) as { status: string };
    expect(v.status).toBe("approved");
    const full = (await toolMap.get("get_suggestion")!.handler({ suggestionId: made.suggestionId, withResult: true })) as {
      createsFile?: boolean;
      resultingContent?: string;
    };
    expect(full.createsFile).toBe(true);
    expect(full.resultingContent).toBe("export const NEW = true;");

    // A second create proposal goes stale the moment a DIFFERENT file lands there.
    const made2 = (await suggest.handler(
      { projectId: p.id, path: "src/other.ts", edits: [{ before: "", after: "A" }], reason: "Adds another module for the demo." },
      ctxOf(bob),
    )) as { suggestionId: string };
    await sync({ projectId: p.id, files: [{ path: "src/other.ts", content: "B" }] });
    await expect(toolMap.get("review_suggestion")!.handler({ suggestionId: made2.suggestionId, verdict: "approve" }, exec)).rejects.toThrow(
      /different file now exists/,
    );
  });

  it("allows a create-form proposal to fill an EMPTY mirrored file", async () => {
    const p = await newProject("sugg8");
    await sync({ projectId: p.id, files: [{ path: "pkg/__init__.py", content: "" }] });
    const made = (await toolMap.get("suggest_change")!.handler(
      { projectId: p.id, path: "pkg/__init__.py", edits: [{ before: "", after: "VERSION = '1.0'" }], reason: "Fill the empty placeholder with the version constant." },
      ctxOf(bob),
    )) as { suggestionId: string };
    const exec = ctxOf({ id: "e9", username: "boss", role: "executive", status: "approved" });
    const v = (await toolMap.get("review_suggestion")!.handler({ suggestionId: made.suggestionId, verdict: "approve" }, exec)) as { status: string };
    expect(v.status).toBe("approved");
  });

  it("never offers resultingContent for an already-applied insertion", async () => {
    const p = await newProject("sugg9");
    const path = "src/foo.ts";
    await sync({ projectId: p.id, files: [{ path, content: "function foo() {\n  return 1;\n}" }] });
    const made = (await toolMap.get("suggest_change")!.handler(
      { projectId: p.id, path, edits: [{ before: "function foo() {", after: "function foo() {\n  log();" }], reason: "Add entry logging to foo for tracing." },
      ctxOf(bob),
    )) as { suggestionId: string };
    const exec = ctxOf({ id: "e9", username: "boss", role: "executive", status: "approved" });
    await toolMap.get("review_suggestion")!.handler({ suggestionId: made.suggestionId, verdict: "approve" }, exec);

    // The owner applies and pushes; CI mirrors the applied content. The anchor
    // SURVIVES inside the applied text, so before the fix this suggestion
    // still validated and get_suggestion offered the doubled content.
    await sync({ projectId: p.id, files: [{ path, content: "function foo() {\n  log();\n  return 1;\n}" }], force: true });
    const full = (await toolMap.get("get_suggestion")!.handler({ suggestionId: made.suggestionId, withResult: true })) as {
      stillApplies: boolean;
      resultingContent?: string;
      blockers?: Array<{ reason: string }>;
    };
    expect(full.stillApplies).toBe(false);
    expect(full.resultingContent).toBeUndefined();
    expect(full.blockers?.[0]?.reason).toMatch(/already applied/);
  });

  it("carries a deletion proposal through its whole life: propose, approve, self-close", async () => {
    const p = await newProject("del1");
    const path = "src/dead.ts";
    await sync({ projectId: p.id, files: [{ path, content: "export const DEAD = true;" }] });
    const exec = ctxOf({ id: "e9", username: "boss", role: "executive", status: "approved" });
    const suggest = toolMap.get("suggest_change")!;

    // deleteFile on a path the mirror does not have: nothing to delete.
    await expect(
      suggest.handler({ projectId: p.id, path: "src/ghost.ts", deleteFile: true, reason: "This module is dead code now." }, ctxOf(bob)),
    ).rejects.toThrow(/nothing to propose deleting/);

    const made = (await suggest.handler(
      { projectId: p.id, path, deleteFile: true, reason: "Dead code — its last caller was removed in the refactor." },
      ctxOf(bob),
    )) as { suggestionId: string; deletesFile?: boolean };
    expect(made.deletesFile).toBe(true);

    const listed = (await toolMap.get("list_suggestions")!.handler({ projectId: p.id })) as {
      suggestions: Array<{ deletesFile?: boolean; stillApplies: boolean }>;
    };
    expect(listed.suggestions[0].deletesFile).toBe(true);
    expect(listed.suggestions[0].stillApplies).toBe(true);

    const v = (await toolMap.get("review_suggestion")!.handler({ suggestionId: made.suggestionId, verdict: "approve" }, exec)) as {
      status: string;
      next: string;
    };
    expect(v.status).toBe("approved");
    expect(v.next).toMatch(/git rm/);

    // The owner deletes it in their checkout and pushes; CI mirrors the removal.
    await sync({ projectId: p.id, files: [], deletes: [path] });
    const after = (await toolMap.get("get_suggestion")!.handler({ suggestionId: made.suggestionId })) as {
      stillApplies: boolean;
      hint: string;
    };
    expect(after.stillApplies).toBe(false);
    expect(after.hint).toMatch(/already gone/);
  });

  it("a deletion goes stale when the file changes before review", async () => {
    const p = await newProject("del2");
    const path = "src/maybe.ts";
    await sync({ projectId: p.id, files: [{ path, content: "v1" }] });
    const made = (await toolMap.get("suggest_change")!.handler(
      { projectId: p.id, path, deleteFile: true, reason: "Looks unused from where I sit." },
      ctxOf(bob),
    )) as { suggestionId: string };
    // Someone updates the file — clearly NOT unused.
    const cur = await readCode(p.id, path);
    await sync({ projectId: p.id, files: [{ path, content: "v2 — now load-bearing", baseHash: cur.hash }] }, alice);
    const exec = ctxOf({ id: "e9", username: "boss", role: "executive", status: "approved" });
    await expect(toolMap.get("review_suggestion")!.handler({ suggestionId: made.suggestionId, verdict: "approve" }, exec)).rejects.toThrow(
      /changed after this deletion was proposed/,
    );
  });

  it("accepts a multi-part new file and returns the joined content on approval", async () => {
    const p = await newProject("mp1");
    const partA = "// A\n".repeat(10);
    const partB = "// B\n".repeat(10);
    const made = (await toolMap.get("suggest_change")!.handler(
      {
        projectId: p.id,
        path: "src/big.ts",
        edits: [
          { before: "", after: partA },
          { before: "", after: partB },
        ],
        reason: "A generated module too large for a single part.",
      },
      ctxOf(bob),
    )) as { suggestionId: string; createsFile?: boolean };
    expect(made.createsFile).toBe(true);
    const exec = ctxOf({ id: "e9", username: "boss", role: "executive", status: "approved" });
    await toolMap.get("review_suggestion")!.handler({ suggestionId: made.suggestionId, verdict: "approve" }, exec);
    const full = (await toolMap.get("get_suggestion")!.handler({ suggestionId: made.suggestionId, withResult: true })) as {
      resultingContent?: string;
    };
    expect(full.resultingContent).toBe(partA + partB);
  });

  it("withdraw: the suggester can take back an open suggestion; a stranger cannot", async () => {
    const p = await newProject("wd1");
    await sync({ projectId: p.id, files: [{ path: "src/w.ts", content: "x = 1" }] });
    const made = (await toolMap.get("suggest_change")!.handler(
      { projectId: p.id, path: "src/w.ts", edits: [{ before: "x = 1", after: "x = 2" }], reason: "Bump the constant for the demo." },
      ctxOf(bob),
    )) as { suggestionId: string };

    const withdraw = toolMap.get("withdraw_suggestion")!;
    // A different member cannot withdraw someone else's proposal.
    await expect(withdraw.handler({ suggestionId: made.suggestionId }, ctxOf(alice))).rejects.toThrow(/only 'bob-dev'/);
    const w = (await withdraw.handler({ suggestionId: made.suggestionId, reason: "superseded" }, ctxOf(bob))) as { status: string };
    expect(w.status).toBe("withdrawn");
    // Withdrawn is final for review purposes.
    const exec = ctxOf({ id: "e9", username: "boss", role: "executive", status: "approved" });
    await expect(toolMap.get("review_suggestion")!.handler({ suggestionId: made.suggestionId, verdict: "approve" }, exec)).rejects.toThrow(
      /already withdrawn/,
    );
  });

  it("delete_item removes a note, audits it, and refuses a member", async () => {
    const p = await newProject("di1");
    const item = await prisma.item.create({
      data: { projectId: p.id, title: "Wrong claim", body: "This turned out to be false.", type: "note", createdBy: "bob-dev", updatedBy: "bob-dev" },
    });
    const del = toolMap.get("delete_item")!;
    await expect(del.handler({ itemId: item.id }, ctxOf(bob))).rejects.toThrow(/owner\/executive/);
    const exec = ctxOf({ id: "e9", username: "boss", role: "executive", status: "approved" });
    const r = (await del.handler({ itemId: item.id, reason: "superseded by the corrected note" }, exec)) as { deleted: boolean };
    expect(r.deleted).toBe(true);
    expect(await prisma.item.findUnique({ where: { id: item.id } })).toBeNull();
    const audit = await prisma.auditEvent.findFirst({ where: { action: "delete_item", target: p.id }, orderBy: { createdAt: "desc" } });
    expect(audit?.detail).toContain("Wrong claim");
    expect(audit?.detail).toContain("superseded");
  });

  it("import_notes updates an existing note by title instead of duplicating it", async () => {
    const importTool = toolMap.get("import_notes")!;
    const name = "ImportDedup-" + Date.now();
    const first = (await importTool.handler(
      { projectName: name, notes: [{ title: "The Decision", body: "v1 of the reasoning" }] },
      ctxOf(bob),
    )) as { projectId: string; noteCount: number };
    const second = (await importTool.handler(
      { projectName: name, notes: [{ title: "the decision", body: "v2 — corrected" }] },
      ctxOf(bob),
    )) as { noteCount: number; updated?: number };
    expect(second.updated).toBe(1);
    const items = await prisma.item.findMany({ where: { projectId: first.projectId } });
    expect(items).toHaveLength(1); // updated, not duplicated — case-insensitive
    expect(items[0].body).toContain("v2 — corrected");
    await prisma.project.delete({ where: { id: first.projectId } });
  });

  it("refuses an ambiguous anchor at proposal time rather than misapplying it later", async () => {
    const p = await newProject("sugg3");
    await sync({ projectId: p.id, files: [{ path: "src/dup.ts", content: "let x = 1;\nlet y = 2;\nlet x = 1;" }] });
    await expect(
      toolMap.get("suggest_change")!.handler(
        {
          projectId: p.id,
          path: "src/dup.ts",
          edits: [{ before: "let x = 1;", after: "let x = 9;" }],
          reason: "This constant should be nine for reasons explained here.",
        },
        ctxOf(bob),
      ),
    ).rejects.toThrow(/occurs 2 times/);
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

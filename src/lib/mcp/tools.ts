import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { detectSignals } from "../attention";
import { rollup, rollupConnected, rollupMany } from "../status";
import { scopeProjectIds } from "../projects";
import { buildTemplatedBriefing } from "../briefing/templated";
import { ITEM_STATUSES, CONTENT_TYPES, importSchema } from "../validation";
import { importProject } from "../import";
import { approveAccount, setRole } from "../accounts";
import { MAX_SYNC_FILES, MAX_TOTAL_FILE_CHARS, READ_WINDOW, READ_WINDOW_MAX, MAX_CODE_VERSIONS, chunkContent, WORK_STATUSES, ACTIVE_WORK_STATUSES, isValidRepoPath, normalizeRepoPath, hashContent, pathOverlap } from "../code";
import { reviewWorkIntent } from "../work";
import { searchItems, snippet } from "../search";
import { validateSkillName, toSkillMarkdown, MAX_SKILL_BODY } from "../skills";
import { buildCorpus, cosine, sharedTerms, detectCommunities } from "../related";
import { diffHunks, type Hunk } from "../diff";
import { validateEdits, applyEdits, suggestionState, isCreateEdits, isDeleteEdits, createContent, DELETE_SENTINEL, renderEdits, MAX_EDITS, MAX_EDIT_CHARS, type Edit } from "../suggest";

// What a teammate changed under you while you were editing, in the form you can
// act on: the exact text that was there and the exact text that replaced it.
type TheirChanges =
  | { changes: Hunk[]; andMore?: number }
  | { rewritten: true; changedLines: number; totalLines: number };

// Text snippet used for similarity: title carries the most signal, body capped
// so one giant note can't dominate corpus building time.
const simText = (title: string, body: string) => `${title}\n${title}\n${body.slice(0, 5000)}`;

// The authenticated caller, resolved from the MCP bearer token by the route.
// null = anonymous (only possible in open local/dev mode).
export type ToolCtx = { account: { id: string; username: string; role: string; status: string } | null };

export type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, ctx?: ToolCtx) => Promise<unknown>;
};

const scopeProp = { type: "string", enum: ["project", "connected", "all"], default: "project" };

// Writes are attributed to the authenticated account when present (enforced
// identity), falling back to a free-text actor only in open/legacy mode.
const actorOf = (ctx?: ToolCtx, fallback?: unknown) =>
  ctx?.account?.username ?? (typeof fallback === "string" && fallback ? fallback : "agent");

function requireApprover(ctx?: ToolCtx) {
  const a = ctx?.account;
  if (!a || a.status !== "approved" || (a.role !== "owner" && a.role !== "executive")) {
    throw new Error("owner/executive identity required (present an approved owner/executive token)");
  }
  return a;
}

// Anything that works inside or outside an interactive transaction.
type Db = Prisma.TransactionClient | typeof prisma;
type MirrorRow = { content: string; hash: string; size: number; ref: string | null; syncedBy: string | null };

// Save a path's current mirror content to history, then trim history to the
// last MAX_CODE_VERSIONS. EVERY destructive path must go through this. The
// manifest prune and the explicit deletes used to drop rows without writing a
// version — the only two places in sync_code that didn't — which is what turned
// "overwritten but recoverable" into "gone" for any file that existed solely in
// the mirror.
async function archiveRows(db: Db, projectId: string, path: string, rows: MirrorRow[]) {
  if (!rows.length) return;
  const head = rows[0];
  await db.codeVersion.create({
    data: {
      projectId,
      path,
      content: rows.map((r) => r.content).join(""),
      hash: head.hash,
      size: head.size,
      ref: head.ref,
      syncedBy: head.syncedBy,
    },
  });
  const stale = await db.codeVersion.findMany({
    where: { projectId, path },
    orderBy: { createdAt: "desc" },
    skip: MAX_CODE_VERSIONS,
    select: { id: true },
  });
  if (stale.length) await db.codeVersion.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
}

// Archive a batch of paths in one read, for the delete and prune paths.
async function archivePaths(db: Db, projectId: string, paths: string[]): Promise<number> {
  if (!paths.length) return 0;
  const rows = await db.codeFile.findMany({
    where: { projectId, path: { in: paths } },
    orderBy: [{ path: "asc" }, { part: "asc" }],
  });
  const byPath = new Map<string, MirrorRow[]>();
  for (const r of rows) {
    const list = byPath.get(r.path);
    if (list) list.push(r);
    else byPath.set(r.path, [r]);
  }
  for (const [p, group] of byPath) await archiveRows(db, projectId, p, group);
  return byPath.size;
}

async function allProjectIds(): Promise<string[]> {
  return (await prisma.project.findMany({ select: { id: true } })).map((p) => p.id);
}

export const tools: Tool[] = [
  {
    name: "whoami",
    description: "Return the identity you are authenticated as (username, role, status), or anonymous if connected with the shared/legacy token.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_a, ctx) =>
      ctx?.account
        ? { username: ctx.account.username, role: ctx.account.role, status: ctx.account.status }
        : { anonymous: true },
  },
  {
    name: "list_projects",
    description: "List all projects (id, name, slug, manual health). Start here to find a projectId.",
    inputSchema: { type: "object", properties: {} },
    handler: async () =>
      prisma.project.findMany({
        orderBy: { updatedAt: "desc" },
        select: { id: true, name: true, slug: true, health: true },
      }),
  },
  {
    name: "get_status",
    description:
      "Get the computed RAG status (red/amber/green) for a project — optionally rolled up across connected projects (scope=connected) or all projects (scope=all). Includes per-project signal counts and the manual override if set.",
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "string" }, scope: scopeProp },
      required: ["projectId"],
    },
    handler: async (a) => {
      const { projectId, scope = "project" } = a as { projectId: string; scope?: string };
      if (scope === "connected") return rollupConnected(projectId);
      if (scope === "all") return rollupMany(await allProjectIds());
      const r = await rollup(projectId);
      return { headline: r.computed, projects: [r] };
    },
  },
  {
    name: "get_attention",
    description:
      "List the areas needing attention (overdue, blocked, open risks, due-soon, stale) for a project/scope. Each signal cites the source item id so you can read_item for detail. Cross-project flags raised via flag_issue show up here too, as do code changes proposed via suggest_change and still awaiting a verdict (kind 'review_pending', carrying suggestionId — those escalate the longer they wait, because someone is blocked on your answer).",
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "string" }, scope: scopeProp },
      required: ["projectId"],
    },
    handler: async (a) => {
      const { projectId, scope = "project" } = a as { projectId: string; scope?: string };
      const ids = (await scopeProjectIds(projectId, scope)) ?? (await allProjectIds());
      return detectSignals(ids);
    },
  },
  {
    name: "get_briefing",
    description:
      "Get a deterministic, cited status briefing (headline, attention, recent decisions and updates) for a project/scope. Zero-token; built only from real items.",
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "string" }, scope: scopeProp },
      required: ["projectId"],
    },
    handler: async (a) => {
      const { projectId, scope = "project" } = a as { projectId: string; scope?: string };
      return buildTemplatedBriefing(projectId, scope);
    },
  },
  {
    name: "search",
    description:
      "Ranked search over item titles and bodies. Ask in natural language — the query is tokenized and results are ranked by how many terms match (title hits weigh more). Wrap in \"double quotes\" for an exact phrase. Scope: this project, connected projects, or all.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, projectId: { type: "string" }, scope: scopeProp },
      required: ["query"],
    },
    handler: async (a) => {
      const { query, projectId = null, scope = "project" } = a as {
        query: string;
        projectId?: string | null;
        scope?: string;
      };
      const ids = await scopeProjectIds(projectId, scope);
      const hits = await searchItems(query, ids);
      return hits.map((h) => ({
        id: h.id,
        title: h.title,
        type: h.type,
        status: h.status,
        projectId: h.projectId,
        project: h.project.name,
        snippet: snippet(h.body, query),
      }));
    },
  },
  {
    name: "read_item",
    description: "Read one item's full content (title, type, status, due date, body).",
    inputSchema: { type: "object", properties: { itemId: { type: "string" } }, required: ["itemId"] },
    handler: async (a) => {
      const { itemId } = a as { itemId: string };
      const it = await prisma.item.findUnique({
        where: { id: itemId },
        select: { id: true, projectId: true, type: true, status: true, dueAt: true, title: true, body: true, updatedAt: true },
      });
      if (!it) throw new Error("item not found");
      return it;
    },
  },
  {
    name: "delete_item",
    description:
      "Owner/executive only: permanently delete one item (note, task, risk). The retraction path that never existed — until now an agent could write a note but never take one back, which mattered most for the worst case: a secret or a wrong claim landing in a shared, searchable vault. Deletion is real (backlinks to the item become ghost links) and the audit trail records who removed what and why.",
    inputSchema: {
      type: "object",
      properties: {
        itemId: { type: "string" },
        reason: { type: "string", description: "why it is being removed — recorded in the audit trail" },
      },
      required: ["itemId"],
    },
    handler: async (a, ctx) => {
      const { itemId, reason } = a as { itemId: string; reason?: string };
      const approver = requireApprover(ctx);
      const it = await prisma.item.findUnique({ where: { id: itemId }, select: { id: true, projectId: true, title: true } });
      if (!it) throw new Error("item not found");
      await prisma.item.delete({ where: { id: itemId } });
      // The audit row IS the retraction record: append-only, so "this existed
      // and was removed by X because Y" survives the deletion itself.
      await prisma.auditEvent.create({
        data: {
          action: "delete_item",
          actor: approver.username,
          target: it.projectId,
          detail: `"${it.title}" (${itemId})${reason?.trim() ? ` — ${reason.trim().slice(0, 300)}` : ""}`,
        },
      });
      return { deleted: true, itemId, title: it.title, projectId: it.projectId, by: approver.username };
    },
  },
  {
    name: "set_status",
    description:
      "Set the status of a task (open|blocked|done) or risk (open|mitigating|accepted|closed). Records who changed it (your account) and when. This is how an agent updates shared state that other agents read on their next get_status.",
    inputSchema: {
      type: "object",
      properties: {
        itemId: { type: "string" },
        status: { type: "string", enum: [...ITEM_STATUSES] },
        actor: { type: "string", description: "legacy only; ignored when authenticated as an account" },
      },
      required: ["itemId", "status"],
    },
    handler: async (a, ctx) => {
      const { itemId, status } = a as { itemId: string; status: string };
      const actor = actorOf(ctx, (a as { actor?: unknown }).actor);
      const closedAt = status === "done" || status === "closed" || status === "accepted" ? new Date() : null;
      // Atomic single-row update — no read-modify-write on the metadata JSON, so
      // two agents writing the same item can't clobber each other. Provenance
      // (who set it, when) goes to the append-only audit log, not a mutable blob.
      const updated = await prisma.item
        .update({
          where: { id: itemId },
          data: { status, closedAt, updatedBy: actor },
          select: { id: true, status: true, updatedAt: true },
        })
        .catch(() => null);
      if (!updated) throw new Error("item not found");
      await prisma.auditEvent.create({ data: { action: "set_status", actor, target: itemId, detail: status } });
      return { ...updated, by: actor };
    },
  },
  {
    name: "append_update",
    description:
      "Append an attributed status update to a project — a short note other agents and humans will see in 'recently updated'. Attributed to your account.",
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "string" }, text: { type: "string" }, actor: { type: "string", description: "legacy only; ignored when authenticated" } },
      required: ["projectId", "text"],
    },
    handler: async (a, ctx) => {
      const { projectId, text } = a as { projectId: string; text: string };
      const actor = actorOf(ctx, (a as { actor?: unknown }).actor);
      const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
      if (!project) throw new Error("project not found");
      const item = await prisma.item.create({
        data: {
          projectId,
          type: "message",
          source: "mcp",
          title: `Status update — ${actor}`,
          body: text,
          metadata: JSON.stringify({ actor, via: "mcp" }),
          createdBy: actor,
          updatedBy: actor,
        },
        select: { id: true, createdAt: true },
      });
      return { ...item, by: actor };
    },
  },
  {
    name: "flag_issue",
    description:
      "Flag a bug/blocker that must be fixed in ANOTHER project (cross-project). Use when a problem you hit needs a fix outside the project you're in. Creates an attention item in the responsible (target) project with the error and problem, attributed to you, optionally addressed to a specific account (toAccount) who then sees it in get_inbox. Surfaces in that project's get_attention. Resolve targetProjectId with list_projects.",
    inputSchema: {
      type: "object",
      properties: {
        targetProjectId: { type: "string", description: "id of the project responsible for the fix" },
        title: { type: "string", description: "short summary of the bug to fix" },
        problem: { type: "string", description: "what is wrong and what triggers it" },
        error: { type: "string", description: "the error message / stack trace observed" },
        fromProject: { type: "string", description: "name/id of the project that hit the bug (provenance)" },
        toAccount: { type: "string", description: "username to address this to (they see it in get_inbox)" },
        severity: { type: "string", enum: ["blocker", "risk"], default: "blocker" },
      },
      required: ["targetProjectId", "title"],
    },
    handler: async (a, ctx) => {
      const { targetProjectId, title, problem = "", error = "", fromProject = "", toAccount = "", severity = "blocker" } = a as {
        targetProjectId: string;
        title: string;
        problem?: string;
        error?: string;
        fromProject?: string;
        toAccount?: string;
        severity?: string;
      };
      const actor = actorOf(ctx, (a as { actor?: unknown }).actor);
      const project = await prisma.project.findUnique({ where: { id: targetProjectId }, select: { id: true } });
      if (!project) throw new Error("target project not found (use list_projects to get its id)");

      let assigneeAccountId: string | null = null;
      if (toAccount) {
        const t = await prisma.account.findUnique({ where: { username: toAccount }, select: { id: true } });
        assigneeAccountId = t?.id ?? null;
      }

      const isRisk = severity === "risk";
      const lines = [`**Flagged from:** ${fromProject || "(unspecified)"} · **by:** ${actor}${toAccount ? ` · **to:** @${toAccount}` : ""} (via MCP)`];
      if (problem) lines.push("", `**Problem:** ${problem}`);
      if (error) lines.push("", "**Error:**", "```", error, "```");

      const item = await prisma.item.create({
        data: {
          projectId: targetProjectId,
          type: isRisk ? "risk" : "task",
          status: isRisk ? "open" : "blocked",
          source: "mcp",
          title: `⚑ ${title}`,
          body: lines.join("\n"),
          assigneeAccountId,
          metadata: JSON.stringify({ actor, via: "mcp", kind: "cross_project_flag", flaggedFrom: fromProject || null, toAccount: toAccount || null }),
          createdBy: actor,
          updatedBy: actor,
        },
        select: { id: true, projectId: true, type: true, status: true, createdAt: true },
      });
      return {
        ...item,
        by: actor,
        addressedTo: toAccount || null,
        note: `Flagged in the target project; surfaces in get_attention as ${isRisk ? "an open risk" : "a blocker"}${toAccount ? ` and in @${toAccount}'s get_inbox` : ""}.`,
      };
    },
  },
  {
    name: "request_info",
    description:
      "Ask a specific account for information you need — e.g. 'how do I integrate X into Lumi?'. Creates an open question in the relevant project addressed to that account; they see it in get_inbox. Attributed to you.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "the project the question is about (use list_projects)" },
        toAccount: { type: "string", description: "username to ask" },
        question: { type: "string" },
      },
      required: ["projectId", "toAccount", "question"],
    },
    handler: async (a, ctx) => {
      const { projectId, toAccount, question } = a as { projectId: string; toAccount: string; question: string };
      const from = actorOf(ctx, (a as { actor?: unknown }).actor);
      const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
      if (!project) throw new Error("project not found (use list_projects to get its id)");
      const target = await prisma.account.findUnique({ where: { username: toAccount }, select: { id: true, username: true } });
      if (!target) throw new Error(`no account '${toAccount}'`);
      const item = await prisma.item.create({
        data: {
          projectId,
          type: "task",
          status: "open",
          source: "mcp",
          title: `❓ ${question.slice(0, 80)}`,
          body: `**Question for @${toAccount}** from ${from}:\n\n${question}`,
          assigneeAccountId: target.id,
          metadata: JSON.stringify({ actor: from, via: "mcp", kind: "info_request", toAccount }),
          createdBy: from,
          updatedBy: from,
        },
        select: { id: true, projectId: true, createdAt: true },
      });
      return { ...item, from, to: target.username, note: `Sent to @${target.username}; they will see it in get_inbox.` };
    },
  },
  {
    name: "get_inbox",
    description:
      "Everything waiting on YOU: cross-project flags and info requests assigned to your account, code suggestions awaiting your review (owner/executive), and verdicts on proposals YOU filed — approved ones you still need to apply, rejected ones with the reviewer's note. Call it at the start of a session; nothing here pushes, so an unread verdict stays unread until someone looks. Requires an approved identity.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_a, ctx) => {
      const me = ctx?.account;
      if (!me) throw new Error("no identity — connect with your approved account token to use get_inbox");

      const isApprover = me.status === "approved" && (me.role === "owner" || me.role === "executive");
      const [assigned, toReview, mine] = await Promise.all([
        prisma.item.findMany({
          where: { assigneeAccountId: me.id, closedAt: null },
          orderBy: { createdAt: "desc" },
          select: { id: true, projectId: true, type: true, status: true, title: true, createdAt: true },
        }),
        // Proposals YOU can act on. Only approvers see this queue, because for
        // anyone else it is not actionable and would just be noise.
        isApprover
          ? prisma.codeSuggestion.findMany({
              where: { status: "open" },
              orderBy: { createdAt: "asc" },
              take: 25,
              select: { id: true, projectId: true, path: true, title: true, suggestedBy: true, createdAt: true, project: { select: { name: true } } },
            })
          : Promise.resolve([]),
        // Verdicts on what you proposed. Approved is not the end of your job —
        // someone still has to apply it — and a rejection carries the note that
        // says what would make it acceptable. Both were previously invisible
        // unless you thought to go looking for your own suggestion by id.
        prisma.codeSuggestion.findMany({
          where: { suggestedBy: me.username, status: { in: ["approved", "rejected"] } },
          orderBy: { updatedAt: "desc" },
          take: 25,
          select: {
            id: true,
            projectId: true,
            path: true,
            title: true,
            status: true,
            reviewedBy: true,
            reviewNote: true,
            updatedAt: true,
            project: { select: { name: true } },
          },
        }),
      ]);

      const awaitingYourReview = toReview.map((s) => ({
        suggestionId: s.id,
        projectId: s.projectId,
        project: s.project.name,
        path: s.path,
        title: s.title ?? `Change to ${s.path}`,
        suggestedBy: s.suggestedBy,
        waitingSince: s.createdAt,
      }));
      const yourProposals = mine.map((s) => ({
        suggestionId: s.id,
        projectId: s.projectId,
        project: s.project.name,
        path: s.path,
        title: s.title ?? `Change to ${s.path}`,
        verdict: s.status,
        reviewedBy: s.reviewedBy,
        reviewNote: s.reviewNote,
        reviewedAt: s.updatedAt,
      }));
      const approvedUnapplied = yourProposals.filter((p) => p.verdict === "approved").length;

      return {
        you: me.username,
        assigned,
        awaitingYourReview,
        yourProposals,
        summary:
          [
            assigned.length ? `${assigned.length} item(s) assigned to you` : "",
            awaitingYourReview.length ? `${awaitingYourReview.length} proposal(s) awaiting your review — review_suggestion` : "",
            approvedUnapplied ? `${approvedUnapplied} of your proposals approved — get_suggestion { withResult: true } and apply them` : "",
          ]
            .filter(Boolean)
            .join(" · ") || "Nothing waiting on you.",
      };
    },
  },
  {
    name: "list_pending_accounts",
    description: "List accounts awaiting approval. Owner/executive only.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_a, ctx) => {
      requireApprover(ctx);
      return prisma.account.findMany({
        where: { status: "pending" },
        orderBy: { createdAt: "asc" },
        select: { id: true, username: true, displayName: true, createdAt: true },
      });
    },
  },
  {
    name: "approve_account",
    description: "Approve a pending account by username. Records who approved it permanently (accountability). Owner/executive only.",
    inputSchema: { type: "object", properties: { username: { type: "string" } }, required: ["username"] },
    handler: async (a, ctx) => {
      const approver = requireApprover(ctx);
      const { username } = a as { username: string };
      const target = await prisma.account.findUnique({ where: { username }, select: { id: true } });
      if (!target) throw new Error("account not found");
      const up = await approveAccount(target.id, approver);
      return { username: up.username, status: up.status, approvedBy: approver.username, approvedAt: up.approvedAt };
    },
  },
  {
    name: "appoint_executive",
    description: "Grant a member approving rights (role=executive). Owner only.",
    inputSchema: { type: "object", properties: { username: { type: "string" } }, required: ["username"] },
    handler: async (a, ctx) => {
      if (ctx?.account?.role !== "owner") throw new Error("owner only");
      const { username } = a as { username: string };
      const target = await prisma.account.findUnique({ where: { username }, select: { id: true } });
      if (!target) throw new Error("account not found");
      const up = await setRole(target.id, "executive", ctx.account);
      return { username: up.username, role: up.role };
    },
  },
  {
    name: "register_mcp",
    description:
      "Register that a project exposes its own MCP endpoint and/or who owns it, so other agents can discover it via find_mcp and route to its owner. Approved identity required; only the current project owner or an owner/executive may change an already-owned project.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "project to register (use list_projects)" },
        mcpUrl: { type: "string", description: "the project's MCP endpoint URL (optional)" },
        ownerUsername: { type: "string", description: "account that owns it; defaults to you" },
      },
      required: ["projectId"],
    },
    handler: async (a, ctx) => {
      if (!ctx?.account) throw new Error("approved identity required");
      const { projectId, mcpUrl, ownerUsername } = a as { projectId: string; mcpUrl?: string; ownerUsername?: string };
      const p = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, ownerAccountId: true } });
      if (!p) throw new Error("project not found (use list_projects)");
      const privileged = ctx.account.role === "owner" || ctx.account.role === "executive";
      if (p.ownerAccountId && p.ownerAccountId !== ctx.account.id && !privileged) {
        throw new Error("only the current project owner or an owner/executive can change this");
      }
      let ownerId = ctx.account.id;
      let ownerName = ctx.account.username;
      if (ownerUsername) {
        const o = await prisma.account.findUnique({ where: { username: ownerUsername }, select: { id: true, username: true } });
        if (!o) throw new Error(`no account '${ownerUsername}'`);
        ownerId = o.id;
        ownerName = o.username;
      }
      const up = await prisma.project.update({
        where: { id: projectId },
        data: { ownerAccountId: ownerId, ...(mcpUrl ? { mcpUrl } : {}) },
        select: { name: true, mcpUrl: true },
      });
      return { project: up.name, owner: ownerName, mcpUrl: up.mcpUrl, hasMcp: !!up.mcpUrl };
    },
  },
  {
    name: "find_mcp",
    description:
      "Discover whether a project exposes its own MCP endpoint and who owns it — so you can connect to it or route a question/flag to the right person. Give a project name, slug, or id.",
    inputSchema: { type: "object", properties: { project: { type: "string", description: "project name, slug, or id" } }, required: ["project"] },
    handler: async (a) => {
      const { project } = a as { project: string };
      const p = await prisma.project.findFirst({
        where: { OR: [{ id: project }, { slug: project }, { name: project }] },
        select: { id: true, name: true, mcpUrl: true, ownerAccountId: true },
      });
      if (!p) throw new Error("project not found");
      let owner: string | null = null;
      if (p.ownerAccountId) {
        const o = await prisma.account.findUnique({ where: { id: p.ownerAccountId }, select: { username: true } });
        owner = o?.username ?? null;
      }
      return {
        project: p.name,
        hasMcp: !!p.mcpUrl,
        mcpUrl: p.mcpUrl ?? null,
        owner,
        hint: p.mcpUrl
          ? `Connect to ${p.mcpUrl}${owner ? ` (owned by @${owner})` : ""}.`
          : owner
            ? `No MCP registered; route to owner @${owner} via request_info/flag_issue.`
            : "No MCP and no owner registered for this project yet.",
      };
    },
  },

  // ---- Shared code layer: agents see the same code + each other's work ----
  {
    name: "sync_code",
    description:
      "Push file snapshots into the project's shared code mirror. USE suggest_change INSTEAD unless you can actually git-push this project: the mirror is not a place to deliver work, and on a replica-mode project this tool refuses you outright. sync_code is for keeping the mirror current on a workspace-mode project you have push rights to; proposing a change you cannot push is suggest_change's job, and prose describing a fix is not a deliverable. Once you are sure this is the right tool: other agents browse what you push with get_code_map / read_code without pulling git. Send only CHANGED files — diff your local files against get_code_map hashes first. You MUST pass baseHash (the hash read_code returned before you edited) to replace a path that is already mirrored: the mirror holds ONE version per path and cannot merge, so the server needs the version you started from to tell whether someone wrote in between. Overwriting without it is refused, not silently applied. A clashing push is reported per-path AND carries theirChanges: the exact before/after snippets of what the other agent changed while you were editing, computed by the server from the two stored versions. Apply those to your copy by searching for the 'before' text (never by line number — it will have moved) and retry with the new baseHash; pass force: true only to replace regardless. Superseded content is always recoverable via get_code_history, including files removed by a delete or a manifest prune. Max 100 files per call; larger files are chunked and rejoined automatically. DO NOT use this to seed a whole repo: contents travel as tool arguments, so a few hundred files would cost you roughly a million output tokens. For a first sync or any bulk update, run the repo's script instead, which reads the files from disk and batches them over HTTP: npx tsx scripts/sync-repo.ts <dir> <projectName> [vaultUrl].",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        ref: { type: "string", description: "branch/commit label, e.g. 'main @ 7a2766e' (optional)" },
        files: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" },
              baseHash: {
                type: "string",
                description:
                  "The hash read_code gave you before you edited. Send it: if someone else wrote this path meanwhile, the push is refused instead of erasing their work.",
              },
            },
            required: ["path", "content"],
          },
        },
        deletes: { type: "array", items: { type: "string" }, description: "paths removed from the repo" },
        manifest: {
          type: "array",
          items: { type: "string" },
          description:
            "The COMPLETE path list of the commit being mirrored. Anything mirrored but absent from it is deleted, and the project is recorded as sitting at this ref. Send it once after the content batches — this is what makes the mirror equal one commit instead of the union of everything ever pushed.",
        },
        force: { type: "boolean", description: "ignore baseHash conflicts and overwrite anyway (previous content still goes to history)" },
        actor: { type: "string", description: "who is syncing (ignored when authenticated)" },
      },
      required: ["projectId", "files"],
    },
    handler: async (a, ctx) => {
      const { projectId, ref, files, deletes, force, manifest } = a as {
        projectId: string;
        ref?: string;
        files: Array<{ path: string; content: string; baseHash?: string }>;
        deletes?: string[];
        force?: boolean;
        manifest?: string[];
      };
      const actor = actorOf(ctx, (a as { actor?: unknown }).actor);
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, mirrorMode: true, mirrorWriter: true },
      });
      if (!project) throw new Error("project not found (use list_projects)");
      // A replica mirror is a derived copy of one commit, written only by CI.
      // Refusing everyone else is the whole point: it makes mirror-only work —
      // and silently losing it — impossible rather than merely recoverable.
      if (project.mirrorMode === "replica" && actor !== project.mirrorWriter) {
        throw new Error(
          `this project's mirror is a read-only replica of git, synced by '${project.mirrorWriter ?? "CI"}' on push to the default branch. Nothing written here would survive the next sync, and it would not be in any commit. PROPOSE your change instead: suggest_change with anchored edits (before:'' parts for a new file, deleteFile:true for a removal) puts it in the owner's review queue, and approval hands them the result to apply and push — the mirror follows. If you have push access to the repo, a PR is the other route.`,
        );
      }
      if (!Array.isArray(files) || files.length > MAX_SYNC_FILES) {
        throw new Error(`files must be an array of at most ${MAX_SYNC_FILES}; sync in batches`);
      }

      const skipped: Array<{ path: string; reason: string }> = [];
      const conflicts: Array<{
        path: string;
        yourBase: string | null;
        currentHash: string | null;
        currentRef: string | null;
        currentSyncedBy: string | null;
        theirChanges?: TheirChanges;
        hint: string;
      }> = [];
      const overwrote: Array<{ path: string; previousHash: string; previousRef: string | null; previousBy: string | null }> = [];
      let synced = 0;
      for (const f of files) {
        if (!f || typeof f.path !== "string" || typeof f.content !== "string") {
          skipped.push({ path: String(f?.path ?? "?"), reason: "malformed entry" });
          continue;
        }
        if (!isValidRepoPath(f.path)) {
          skipped.push({ path: f.path, reason: "invalid repo path" });
          continue;
        }
        if (f.content.length > MAX_TOTAL_FILE_CHARS) {
          skipped.push({ path: f.path, reason: `over ${MAX_TOTAL_FILE_CHARS} chars even chunked` });
          continue;
        }
        const path = normalizeRepoPath(f.path);
        const incomingHash = hashContent(f.content);
        // Big files are stored across several rows and rejoined on read, so a
        // project's largest modules stay in the mirror instead of vanishing.
        const chunks = chunkContent(f.content);
        const shared = {
          hash: incomingHash,
          size: f.content.length,
          parts: chunks.length,
          ref: ref ?? null,
          syncedBy: actor,
        };

        // One transaction per file, and the overwrite is guarded by a
        // CONDITIONAL update rather than a bare read-then-write. A read
        // followed by an unguarded write is not a compare-and-swap: two agents
        // can both read hash X, both conclude they are safe, and both write.
        // The loser's content then exists nowhere — not in the slot, and not in
        // history either, because the winner archived the same stale copy the
        // loser did. Putting `hash` in the WHERE makes the loser match zero
        // rows instead of silently winning.
        const result = await prisma.$transaction(
          async (tx) => {
            const rows = await tx.codeFile.findMany({ where: { projectId, path }, orderBy: { part: "asc" } });
            const cur = rows[0];

            if (cur && cur.hash !== incomingHash) {
              // Replacing an existing file requires an explicit statement of
              // intent: either the hash you started from, so the server can
              // tell whether the slot moved under you, or force. baseHash used
              // to be optional, which meant the default behaviour for any agent
              // that had never heard of it was to silently overwrite a
              // teammate — and the onboarding CLAUDE.md never mentioned it.
              if (!force && f.baseHash !== cur.hash) {
                return { kind: "conflict" as const, cur, sentBase: Boolean(f.baseHash), currentContent: rows.map((r) => r.content).join("") };
              }
              await archiveRows(tx, projectId, path, rows);
            }

            if (cur) {
              const claimed = await tx.codeFile.updateMany({
                where: { projectId, path, part: 0, hash: cur.hash },
                data: { content: chunks[0], ...shared },
              });
              if (claimed.count === 0) return { kind: "raced" as const };
            } else {
              // No row yet. A unique-constraint violation means another agent
              // created this same path in between, which is the same race.
              try {
                await tx.codeFile.create({ data: { projectId, path, part: 0, content: chunks[0], ...shared } });
              } catch {
                return { kind: "raced" as const };
              }
            }

            for (let part = 1; part < chunks.length; part++) {
              await tx.codeFile.upsert({
                where: { projectId_path_part: { projectId, path, part } },
                create: { projectId, path, part, content: chunks[part], ...shared },
                update: { content: chunks[part], ...shared },
              });
            }
            // A file that shrank leaves orphan chunks behind; drop them.
            await tx.codeFile.deleteMany({ where: { projectId, path, part: { gte: chunks.length } } });
            return { kind: "written" as const, replaced: cur && cur.hash !== incomingHash ? cur : null };
          },
          { timeout: 20_000 },
        );

        if (result.kind === "conflict") {
          // What changed underneath you, as before/after SNIPPETS rather than
          // line numbers. Both sides are already stored — the version you based
          // on is in history under the hash you sent, and the current one is in
          // the slot — so the server computes this itself. Nobody has to
          // remember to record what they changed, and nobody can misreport it.
          //
          // Snippets rather than coordinates because a line number goes stale
          // the moment anyone inserts a line above it and still resolves,
          // pointing confidently at the wrong code. A snippet that is genuinely
          // gone simply is not found.
          let theirChanges: TheirChanges | undefined;
          if (result.sentBase) {
            const base = await prisma.codeVersion.findFirst({
              where: { projectId, path, hash: f.baseHash },
              orderBy: { createdAt: "desc" },
            });
            if (base) {
              const d = diffHunks(base.content, result.currentContent);
              if (d.kind === "hunks") theirChanges = { changes: d.hunks, ...(d.more ? { andMore: d.more } : {}) };
              else if (d.kind === "rewritten") theirChanges = { rewritten: true, changedLines: d.changedLines, totalLines: d.totalLines };
            }
          }
          conflicts.push({
            path,
            yourBase: f.baseHash ?? null,
            currentHash: result.cur.hash,
            currentRef: result.cur.ref,
            currentSyncedBy: result.cur.syncedBy,
            ...(theirChanges ? { theirChanges } : {}),
            hint: !result.sentBase
              ? `this path is already in the mirror and you sent no baseHash, so the server cannot tell whether you started from the current version. read_code it, then sync with baseHash ${result.cur.hash}. Pass force: true only if you mean to replace it whatever it holds.`
              : theirChanges
                ? `${result.cur.syncedBy ?? "someone"} changed this since you read it — theirChanges lists exactly what, as before/after snippets. Apply those to YOUR copy (search for the 'before' text; it may have moved), then sync with baseHash ${result.cur.hash}. Nothing was lost either way.`
                : `${result.cur.syncedBy ?? "someone"} changed this since you read it, and the version you started from is no longer in history so the difference cannot be shown. read_code it again, merge their changes into yours, then sync with baseHash ${result.cur.hash}.`,
          });
          continue;
        }
        if (result.kind === "raced") {
          conflicts.push({
            path,
            yourBase: f.baseHash ?? null,
            currentHash: null,
            currentRef: null,
            currentSyncedBy: null,
            hint: "another sync wrote this path while yours was still in flight. Nothing was lost — read_code it again and retry.",
          });
          continue;
        }
        if (result.replaced) {
          overwrote.push({ path, previousHash: result.replaced.hash, previousRef: result.replaced.ref, previousBy: result.replaced.syncedBy });
        }
        synced++;
      }

      let deleted = 0;
      const toDelete: string[] = [];
      for (const d of deletes ?? []) {
        if (typeof d !== "string") continue;
        // Silently skipping an invalid delete meant a caller could believe a
        // path was removed when it never was.
        if (!isValidRepoPath(d)) {
          skipped.push({ path: d, reason: "invalid repo path (delete)" });
          continue;
        }
        toDelete.push(normalizeRepoPath(d));
      }
      if (toDelete.length) {
        deleted = await archivePaths(prisma, projectId, toDelete);
        await prisma.codeFile.deleteMany({ where: { projectId, path: { in: toDelete } } });
      }

      // A manifest is the complete path list of the commit being mirrored.
      // Anything not in it is gone from the tree, so it goes from the mirror —
      // this is what makes the mirror equal ONE commit rather than the union of
      // every file anyone ever pushed. Sent once after the content batches.
      let pruned = 0;
      if (Array.isArray(manifest)) {
        const keep = new Set(manifest.filter((m) => typeof m === "string").map(normalizeRepoPath));
        const present = await prisma.codeFile.findMany({
          where: { projectId, part: 0 },
          select: { path: true },
        });
        const gone = present.map((p) => p.path).filter((p) => !keep.has(p));
        if (gone.length) {
          // Archive first. This was the single line that made mirror-only work
          // unrecoverable: a file the repo never had is absent from every
          // manifest, so it was hard-deleted here with no version written and
          // no prior version to fall back on — while the CI log reported it as
          // an ordinary "N removed", indistinguishable from a real deletion.
          await archivePaths(prisma, projectId, gone);
          await prisma.codeFile.deleteMany({ where: { projectId, path: { in: gone } } });
          pruned = gone.length; // files removed, counted apart from explicit deletes
        }
        // Stamp the ref on everything in the manifest, including files whose
        // content was unchanged and therefore never resent. ref means "verified
        // present at this commit", not "last written during it" — otherwise a
        // mirror can hold exactly the right bytes and still look like it spans
        // five commits, which is the confusing half of the soup problem.
        if (ref && keep.size) {
          await prisma.codeFile.updateMany({
            where: { projectId, path: { in: [...keep] } },
            data: { ref },
          });
        }
        // A manifest means this was a whole-tree sync, so the project now sits
        // at exactly this ref — which is what staleness checks compare against.
        await prisma.project.update({
          where: { id: projectId },
          data: { mirrorRef: ref ?? null, mirrorSyncedAt: new Date() },
        });
      }

      await prisma.auditEvent.create({
        data: {
          action: "sync_code",
          actor,
          target: projectId,
          detail: `${synced} synced, ${deleted} deleted, ${conflicts.length} conflicted${ref ? ` @ ${ref}` : ""}`,
        },
      });
      return {
        synced,
        deleted,
        pruned,
        skipped,
        conflicts,
        overwrote,
        by: actor,
        ...(conflicts.length
          ? { warning: `${conflicts.length} file(s) were NOT written because someone changed them after you read them. Merge and retry — nothing was lost.` }
          : {}),
        ...(overwrote.length && !conflicts.length
          ? { note: `Replaced ${overwrote.length} file(s); the previous content is in get_code_history if it is needed back.` }
          : {}),
      };
    },
  },
  {
    name: "get_code_map",
    description:
      "The project's shared code mirror as a tree: every synced file's path, content hash, size, ref, who synced it and when. Diff hashes against your local files to know what changed without reading contents.",
    inputSchema: { type: "object", properties: { projectId: { type: "string" } }, required: ["projectId"] },
    handler: async (a) => {
      const { projectId } = a as { projectId: string };
      // Only chunk 0 carries the file-level metadata, so a chunked file appears
      // once with its whole size rather than once per stored row.
      const [project, files] = await Promise.all([
        prisma.project.findUnique({
          where: { id: projectId },
          select: { mirrorMode: true, mirrorWriter: true, mirrorRef: true, mirrorSyncedAt: true },
        }),
        prisma.codeFile.findMany({
          where: { projectId, part: 0 },
          orderBy: { path: "asc" },
          select: { path: true, hash: true, size: true, parts: true, ref: true, syncedBy: true, updatedAt: true },
        }),
      ]);

      // Silent staleness is worse than an error: an agent reads three-commit-old
      // code, nothing looks wrong, and it reasons confidently from fiction. A
      // mirror written per-file over time is not a snapshot — it can hold a
      // combination of versions that never coexisted in the repo — so say so.
      const byRef = new Map<string, number>();
      for (const f of files) byRef.set(f.ref ?? "(none)", (byRef.get(f.ref ?? "(none)") ?? 0) + 1);
      const refs = [...byRef.entries()]
        .map(([ref, count]) => ({ ref, count }))
        .sort((x, y) => y.count - x.count);
      const consistent = refs.length <= 1;
      const expected = project?.mirrorRef ?? null;
      const stale = expected ? files.filter((f) => f.ref !== expected).length : 0;

      return {
        projectId,
        fileCount: files.length,
        mirrorMode: project?.mirrorMode ?? "workspace",
        ...(project?.mirrorMode === "replica" ? { mirrorWriter: project.mirrorWriter } : {}),
        mirrorRef: expected,
        mirrorSyncedAt: project?.mirrorSyncedAt ?? null,
        consistent,
        refs,
        ...(consistent
          ? {}
          : {
              warning: `This mirror spans ${refs.length} refs, so it is NOT a snapshot of any single commit — files here may be versions that never coexisted in the repo, and you cannot assume the tree builds. Treat older-ref files as possibly stale and check git for anything you are about to reason from.${stale ? ` ${stale} file(s) differ from the project's recorded ref ${expected}.` : ""}`,
            }),
        files,
      };
    },
  },
  {
    name: "read_code",
    description:
      "Read one file from the project's shared code mirror (synced by agents via sync_code). Big files are returned in windows rather than whole — a 1 MB module is ~300k tokens and would swamp your context. When the response says truncated, call again with the offset it gives you, or pass offset/maxChars to read just the region you care about.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        path: { type: "string" },
        offset: { type: "number", description: "character offset to start from (default 0)" },
        maxChars: { type: "number", description: `characters to return (default ${READ_WINDOW}, max ${READ_WINDOW_MAX})` },
      },
      required: ["projectId", "path"],
    },
    handler: async (a) => {
      const { projectId, path, offset, maxChars } = a as {
        projectId: string;
        path: string;
        offset?: number;
        maxChars?: number;
      };
      const rows = await prisma.codeFile.findMany({
        where: { projectId, path: normalizeRepoPath(path) },
        orderBy: { part: "asc" },
      });
      if (!rows.length) throw new Error("file not in the mirror (see get_code_map; an agent may need to sync_code it)");
      const file = rows[0];
      const full = rows.map((r) => r.content).join(""); // rejoined from its chunks

      const start = Math.max(0, Math.floor(Number(offset) || 0));
      const window = Math.min(Math.max(1, Math.floor(Number(maxChars) || READ_WINDOW)), READ_WINDOW_MAX);
      const content = full.slice(start, start + window);
      const end = start + content.length;
      const truncated = end < full.length;

      return {
        path: file.path,
        content,
        size: full.length,
        offset: start,
        returned: content.length,
        truncated,
        ...(truncated
          ? {
              nextOffset: end,
              hint: `Showing ${start}-${end} of ${full.length} chars. Call read_code again with offset ${end} for the next window.`,
            }
          : {}),
        hash: file.hash,
        parts: rows.length,
        ref: file.ref,
        syncedBy: file.syncedBy,
        updatedAt: file.updatedAt,
      };
    },
  },
  {
    name: "set_mirror_mode",
    description:
      "Choose how a project's code mirror is written. 'replica' makes it a read-only copy of one git commit, written solely by the CI account you name — nothing can then live in the mirror that is not in git, which is what stops mirror-only work being lost. 'workspace' keeps it directly writable, which is correct only for projects with no git remote. Owner/executive only.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        mode: { type: "string", enum: ["workspace", "replica"] },
        writer: { type: "string", description: "account username allowed to sync in replica mode (the CI account)" },
      },
      required: ["projectId", "mode"],
    },
    handler: async (a, ctx) => {
      const approver = requireApprover(ctx);
      const { projectId, mode, writer } = a as { projectId: string; mode: string; writer?: string };
      if (mode !== "workspace" && mode !== "replica") throw new Error("mode must be workspace or replica");
      if (mode === "replica" && !writer) {
        throw new Error("replica mode needs a writer: the account CI authenticates as, e.g. the one whose ovk_ token your GitHub Action holds");
      }
      if (writer) {
        const acc = await prisma.account.findUnique({ where: { username: writer }, select: { username: true, status: true } });
        if (!acc) throw new Error(`no account '${writer}' — create one for CI first, then approve it`);
        if (acc.status !== "approved") throw new Error(`account '${writer}' is ${acc.status}; approve it before CI can sync`);
      }
      const updated = await prisma.project
        .update({
          where: { id: projectId },
          data: { mirrorMode: mode, mirrorWriter: mode === "replica" ? writer! : null },
          select: { name: true, mirrorMode: true, mirrorWriter: true },
        })
        .catch(() => null);
      if (!updated) throw new Error("project not found");
      await prisma.auditEvent.create({
        data: { action: "set_mirror_mode", actor: approver.username, target: projectId, detail: `${mode}${writer ? ` (${writer})` : ""}` },
      });
      return {
        project: updated.name,
        mirrorMode: updated.mirrorMode,
        mirrorWriter: updated.mirrorWriter,
        by: approver.username,
        note:
          mode === "replica"
            ? `Only '${writer}' may sync_code now. Install the GitHub Action from the connect kit so the mirror follows the default branch.`
            : "The mirror is directly writable again. Prefer this only for projects with no git remote.",
      };
    },
  },
  {
    name: "get_code_history",
    description:
      "Previous versions of a mirrored file, newest first — every version that was replaced by a later sync. Use it when a push overwrote something that should not have been lost, or to see who has been writing this path. restore_code puts one back.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        path: { type: "string" },
        preview: { type: "number", description: "characters of each version to preview (default 400, 0 for none)" },
      },
      required: ["projectId", "path"],
    },
    handler: async (a) => {
      const { projectId, path, preview } = a as { projectId: string; path: string; preview?: number };
      const p = normalizeRepoPath(path);
      const chars = preview === undefined ? 400 : Math.max(0, Math.min(Number(preview) || 0, 4000));
      const [current, versions] = await Promise.all([
        prisma.codeFile.findFirst({ where: { projectId, path: p }, orderBy: { part: "asc" } }),
        prisma.codeVersion.findMany({
          where: { projectId, path: p },
          orderBy: { createdAt: "desc" },
          take: MAX_CODE_VERSIONS,
        }),
      ]);
      return {
        path: p,
        current: current
          ? { hash: current.hash, size: current.size, ref: current.ref, syncedBy: current.syncedBy, updatedAt: current.updatedAt }
          : null,
        versionCount: versions.length,
        versions: versions.map((v) => ({
          versionId: v.id,
          hash: v.hash,
          size: v.size,
          ref: v.ref,
          syncedBy: v.syncedBy,
          replacedAt: v.createdAt,
          ...(chars ? { preview: v.content.slice(0, chars) } : {}),
        })),
        hint: versions.length
          ? "restore_code with a versionId puts that content back as the current version (the version it replaces is itself kept)."
          : "No superseded versions — this path has only ever been written once.",
      };
    },
  },
  {
    name: "restore_code",
    description:
      "Put a previous version of a mirrored file back as the current one. The version being replaced is itself saved to history first, so restoring is never destructive and can be undone.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        versionId: { type: "string", description: "from get_code_history" },
        actor: { type: "string", description: "who is restoring (ignored when authenticated)" },
      },
      required: ["projectId", "versionId"],
    },
    handler: async (a, ctx) => {
      const { projectId, versionId } = a as { projectId: string; versionId: string };
      const actor = actorOf(ctx, (a as { actor?: unknown }).actor);
      const proj = await prisma.project.findUnique({ where: { id: projectId }, select: { mirrorMode: true } });
      if (proj?.mirrorMode === "replica") {
        // Restoring into a derived mirror would put back a version git does not
        // have at HEAD, recreating the exact drift replica mode exists to end.
        throw new Error(
          "this mirror is a replica of git — git is its history. If you can push: git revert/checkout, and the mirror follows on the next sync. If you cannot: suggest_change with the old content as anchored edits puts the restore in the owner's review queue.",
        );
      }
      const version = await prisma.codeVersion.findUnique({ where: { id: versionId } });
      if (!version || version.projectId !== projectId) throw new Error("version not found on this project (use get_code_history)");

      const path = version.path;
      const existingRows = await prisma.codeFile.findMany({ where: { projectId, path }, orderBy: { part: "asc" } });
      const existing = existingRows[0];
      // Keep what we are about to replace, so a restore can itself be undone.
      if (existing && existing.hash !== version.hash) {
        await prisma.codeVersion.create({
          data: {
            projectId,
            path,
            content: existingRows.map((r) => r.content).join(""),
            hash: existing.hash,
            size: existing.size,
            ref: existing.ref,
            syncedBy: existing.syncedBy,
          },
        });
      }

      const chunks = chunkContent(version.content);
      const shared = {
        hash: version.hash,
        size: version.size,
        parts: chunks.length,
        ref: version.ref ? `${version.ref} (restored)` : "restored",
        syncedBy: actor,
      };
      for (let part = 0; part < chunks.length; part++) {
        await prisma.codeFile.upsert({
          where: { projectId_path_part: { projectId, path, part } },
          create: { projectId, path, part, content: chunks[part], ...shared },
          update: { content: chunks[part], ...shared },
        });
      }
      await prisma.codeFile.deleteMany({ where: { projectId, path, part: { gte: chunks.length } } });
      await prisma.auditEvent.create({
        data: { action: "restore_code", actor, target: projectId, detail: `${path} -> ${version.hash.slice(0, 12)}` },
      });
      return { path, restoredHash: version.hash, size: version.size, by: actor, replacedHash: existing?.hash ?? null };
    },
  },

  // ---- Suggested changes: the route for people who cannot write the code ----
  //
  // Replica mode makes the mirror read-only, which is right — nothing should
  // live in a copy of git that git does not have. But that leaves an obvious
  // question: where does a change GO when the person proposing it has no push
  // access, or should not be pushing unreviewed?
  //
  // Here. The vault holds the proposal and never touches git; the project owner
  // is the bridge. Their agent applies the approved edits to the real checkout
  // and pushes, and CI mirrors the result. No git credential is ever stored, no
  // merge is ever performed by the vault, and nothing lands that a human did
  // not approve on their own machine.
  {
    name: "suggest_change",
    description:
      "Propose a change to a file you cannot or should not write yourself — the route for a collaborator with no git access, or for any agent on a replica-mode project, and the way work actually gets delivered on those: an approved suggestion is applied by the owner and pushed, whereas prose describing a fix is undelivered work. Handles all three change types. CHANGE a file: content-anchored edits — the EXACT text to replace and what it becomes, never line numbers, because the file may move before anyone applies this; each 'before' must occur exactly once in the current mirrored version, and the server refuses otherwise so a stale or ambiguous suggestion is caught now rather than misapplied later. NEW file: edits with before: '' carrying the content — several parts if it exceeds the per-edit cap, concatenated in order, so one big file stays one reviewable suggestion. REMOVE a file: pass deleteFile: true and no edits. The reason is required and becomes a linked note, so why this change happened outlives the review. Check list_suggestions first so you don't duplicate an open proposal; withdraw_suggestion takes back your own.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        path: { type: "string", description: "repo-relative path, as it appears in get_code_map" },
        edits: {
          type: "array",
          description:
            "applied in order; a later 'before' may match text an earlier edit produced. For a NEW file: every edit has before '' and the afters are concatenated — several parts let a file over the per-edit cap travel as one suggestion. Omit entirely with deleteFile: true.",
          items: {
            type: "object",
            properties: {
              before: { type: "string", description: "exact existing text, with enough surrounding lines to be unique ('' for new-file parts)" },
              after: { type: "string", description: "what it becomes ('' to delete that text)" },
            },
            required: ["before", "after"],
          },
        },
        deleteFile: {
          type: "boolean",
          description:
            "propose REMOVING this file entirely (no edits). Goes stale if the file changes before review, and closes itself once the file is gone from the mirror.",
        },
        reason: { type: "string", description: "why this change is needed — required, and kept as a note" },
        title: { type: "string", description: "short label for the review queue" },
        expectedHash: {
          type: "string",
          description:
            "optional: the mirror hash your working copy was checked out at. If the mirror has moved past it the response carries a warning, so drift is flagged at proposal time instead of surprising the reviewer.",
        },
        actor: { type: "string", description: "who is proposing (ignored when authenticated)" },
      },
      // edits is NOT in required: a deletion proposal (deleteFile: true) has
      // none, and the handler enforces edits-or-deleteFile itself. Handler
      // tests call past the transport's required-args check, so a mistake here
      // is invisible to them and only surfaces over real MCP — which is
      // exactly how it was found.
      required: ["projectId", "path", "reason"],
    },
    handler: async (a, ctx) => {
      const { projectId, path: rawPath, reason, title, deleteFile } = a as {
        projectId: string;
        path: string;
        reason: string;
        title?: string;
        deleteFile?: boolean;
      };
      const actor = actorOf(ctx, (a as { actor?: unknown }).actor);
      const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, name: true, repoUrl: true } });
      if (!project) throw new Error("project not found (use list_projects)");
      if (typeof reason !== "string" || reason.trim().length < 10) {
        throw new Error("reason is required and must actually explain the change — it becomes the note that outlives this review");
      }
      const path = normalizeRepoPath(rawPath);
      if (!isValidRepoPath(path)) throw new Error("invalid repo path");

      // Three change types, one tool: deleteFile is its own flag rather than a
      // magic edit shape at the API surface; internally it is stored as the
      // sentinel no other kind can produce.
      const rawEdits = (a as { edits?: Edit[] }).edits;
      let edits: Edit[];
      if (deleteFile) {
        if (Array.isArray(rawEdits) && rawEdits.length) throw new Error("deleteFile takes no edits — it proposes removing the whole file");
        edits = DELETE_SENTINEL;
      } else {
        if (!Array.isArray(rawEdits) || !rawEdits.length) throw new Error("edits must be a non-empty array of { before, after } (or pass deleteFile: true)");
        if (rawEdits.length > MAX_EDITS) throw new Error(`at most ${MAX_EDITS} edits per suggestion; split it up`);
        edits = rawEdits;
      }

      const rows = await prisma.codeFile.findMany({ where: { projectId, path }, orderBy: { part: "asc" } });
      const existingContent = rows.length ? rows.map((r) => r.content).join("") : null;
      const creating = !deleteFile && isCreateEdits(edits);
      if (deleteFile) {
        // Deleting needs a file to delete. The recorded hash is the staleness
        // anchor: if the file changes before review, the proposer was looking
        // at something other than what would now be removed.
        if (existingContent === null) throw new Error(`'${path}' is not in the code mirror — nothing to propose deleting.`);
      } else if (creating) {
        // A NEW file: nothing to anchor on, so the edits ARE the file — afters
        // concatenated in order, several parts when it exceeds the per-edit
        // cap. An EMPTY mirrored file counts as absent here — a placeholder
        // like __init__.py has no text an ordinary edit could anchor on, so
        // without this it would be a dead end no proposal could ever grow.
        if (existingContent !== null && existingContent.trim()) {
          throw new Error(`'${path}' already exists in the mirror — propose anchored edits to it instead of a new file.`);
        }
        const over = edits.findIndex((e) => e.after.length > MAX_EDIT_CHARS);
        if (over !== -1) {
          throw new Error(`part ${over + 1} exceeds ${MAX_EDIT_CHARS} characters — split the content into more parts (up to ${MAX_EDITS})`);
        }
      } else if (existingContent === null) {
        throw new Error(
          `'${path}' is not in the code mirror, so there is nothing to anchor a change against. get_code_map to see what is. To propose a NEW file, send edits with before: "" carrying the content; to propose removing a file, pass deleteFile: true.`,
        );
      } else {
        const { checks, ok } = validateEdits(existingContent, edits);
        if (!ok) {
          const bad = checks.filter((c) => !c.ok).map((c) => `edit ${c.index + 1}: ${c.reason}`);
          throw new Error(`these edits do not match the file as it stands:\n${bad.join("\n")}`);
        }
      }
      // An optional watermark from a working-copy checkout: when the mirror has
      // moved past it, the edits may still anchor — content anchors tolerate
      // disjoint drift by design — but the proposer should re-read before an
      // owner reviews a composition neither party saw whole.
      const expectedHash = typeof (a as { expectedHash?: unknown }).expectedHash === "string" ? ((a as { expectedHash: string }).expectedHash || null) : null;
      const moved = Boolean(expectedHash && rows[0] && rows[0].hash !== expectedHash);

      // The reason becomes a real note, linked to the project's knowledge graph.
      // A pull-request description dies with the pull request; this is the part
      // that is still answerable in a year when someone asks why the code looks
      // like this.
      const note = await prisma.item.create({
        data: {
          projectId,
          type: "decision",
          source: "mcp",
          title: `Proposed: ${title?.trim() || (deleteFile ? `delete ${path}` : path)}`,
          body: `**Suggested by:** ${actor} · **file:** \`${path}\`\n\n${reason.trim()}\n\n---\n\n${renderEdits(path, edits)}`,
          metadata: JSON.stringify({ actor, via: "mcp", kind: "code_suggestion", path }),
          createdBy: actor,
          updatedBy: actor,
        },
        select: { id: true },
      });

      const suggestion = await prisma.codeSuggestion.create({
        data: {
          projectId,
          path,
          edits: JSON.stringify(edits),
          reason: reason.trim(),
          title: title?.trim() || null,
          baseHash: rows[0]?.hash ?? null,
          baseRef: rows[0]?.ref ?? null,
          suggestedBy: actor,
          noteItemId: note.id,
        },
        select: { id: true, status: true, createdAt: true },
      });
      await prisma.auditEvent.create({
        data: { action: "suggest_change", actor, target: projectId, detail: `${path}: ${title?.trim() || reason.trim().slice(0, 120)}` },
      });
      return {
        suggestionId: suggestion.id,
        status: suggestion.status,
        path,
        edits: edits.length,
        ...(deleteFile ? { deletesFile: true } : {}),
        ...(creating ? { createsFile: true } : {}),
        noteItemId: note.id,
        by: actor,
        note: `Recorded ${deleteFile ? "as a DELETION" : creating ? "as a NEW file" : `against ${rows[0]?.ref ?? "the current mirror"}`}. An owner or executive reviews it with review_suggestion; nothing changes in the mirror or in git until they do${project.repoUrl ? `. If you have write access to ${project.repoUrl}, a pull request there is still the better route` : ""}.`,
        ...(moved
          ? {
              warning: `the mirror moved past the version this working copy was based on (${expectedHash!.slice(0, 12)}… → ${rows[0]!.hash.slice(0, 12)}…). Your edits still anchor, but read_code the current file to confirm they compose with the newer changes before the owner reviews.`,
            }
          : {}),
      };
    },
  },
  {
    name: "list_suggestions",
    description:
      "Proposed code changes for a project, newest first. Staleness is recomputed against the mirror on every read, never cached: a suggestion whose anchor text has since changed is reported as no longer applying, rather than looking fine until someone tries it.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        status: { type: "string", enum: ["open", "approved", "rejected", "applied", "withdrawn"] },
      },
      required: ["projectId"],
    },
    handler: async (a) => {
      const { projectId, status } = a as { projectId: string; status?: string };
      const rows = await prisma.codeSuggestion.findMany({
        where: { projectId, ...(status ? { status } : {}) },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
      const suggestions = [];
      for (const s of rows) {
        const parts = await prisma.codeFile.findMany({ where: { projectId, path: s.path }, orderBy: { part: "asc" } });
        const content = parts.map((p) => p.content).join("");
        const edits = JSON.parse(s.edits) as Edit[];
        const st = suggestionState(parts.length ? content : null, edits, s.baseHash);
        suggestions.push({
          suggestionId: s.id,
          path: s.path,
          title: s.title,
          reason: s.reason,
          status: st.applied && s.status !== "applied" ? "applied" : s.status,
          suggestedBy: s.suggestedBy,
          reviewedBy: s.reviewedBy,
          reviewNote: s.reviewNote,
          editCount: edits.length,
          noteItemId: s.noteItemId,
          createdAt: s.createdAt,
          stillApplies: st.stillApplies,
          ...(st.kind === "create" ? { createsFile: true } : {}),
          ...(st.kind === "delete" ? { deletesFile: true } : {}),
          ...(st.applied ? { detectedInMirror: true } : {}),
        });
      }
      return {
        suggestions,
        open: suggestions.filter((s) => s.status === "open").length,
        hint: "get_suggestion for the exact edits; review_suggestion to approve or reject (owner/executive).",
      };
    },
  },
  {
    name: "get_suggestion",
    description:
      "One proposed change in full: the exact before/after edits, the reason, who proposed it, and whether it still applies to the file as it stands now. Approved suggestions also return the resulting file content, so the owner's agent can apply it to the real checkout without re-deriving anything.",
    inputSchema: {
      type: "object",
      properties: { suggestionId: { type: "string" }, withResult: { type: "boolean", description: "include the full resulting file content" } },
      required: ["suggestionId"],
    },
    handler: async (a) => {
      const { suggestionId, withResult } = a as { suggestionId: string; withResult?: boolean };
      const s = await prisma.codeSuggestion.findUnique({ where: { id: suggestionId } });
      if (!s) throw new Error("suggestion not found");
      const parts = await prisma.codeFile.findMany({ where: { projectId: s.projectId, path: s.path }, orderBy: { part: "asc" } });
      const content = parts.map((p) => p.content).join("");
      const edits = JSON.parse(s.edits) as Edit[];
      const st = suggestionState(parts.length ? content : null, edits, s.baseHash);
      const blockers = st.stillApplies
        ? []
        : st.applied
          ? [
              {
                index: 0,
                ok: false,
                occurrences: 0,
                reason:
                  st.kind === "delete"
                    ? "the file is already gone from the mirror — appears applied"
                    : "appears already applied — the mirror already holds the proposed result",
              },
            ]
          : st.kind === "delete"
            ? [{ index: 0, ok: false, occurrences: 0, reason: "the file changed after this deletion was proposed — what would be removed is not what the author saw" }]
            : st.kind === "create"
              ? [{ index: 0, ok: false, occurrences: 0, reason: "a file now exists at this path with different content" }]
              : parts.length
                ? validateEdits(content, edits).checks.filter((c) => !c.ok)
                : [{ index: 0, ok: false, occurrences: 0, reason: "the file is no longer in the mirror" }];
      const project = await prisma.project.findUnique({ where: { id: s.projectId }, select: { repoUrl: true } });
      return {
        suggestionId: s.id,
        projectId: s.projectId,
        path: s.path,
        title: s.title,
        reason: s.reason,
        edits,
        status: s.status,
        suggestedBy: s.suggestedBy,
        reviewedBy: s.reviewedBy,
        reviewNote: s.reviewNote,
        noteItemId: s.noteItemId,
        proposedAgainst: s.baseRef ?? s.baseHash ?? "(new file)",
        ...(st.kind === "create" ? { createsFile: true } : {}),
        ...(st.kind === "delete" ? { deletesFile: true } : {}),
        stillApplies: st.stillApplies,
        ...(st.stillApplies ? {} : { blockers }),
        ...(st.stillApplies && withResult && s.status === "approved" && st.kind !== "delete"
          ? { resultingContent: st.kind === "create" ? createContent(edits) : applyEdits(content, edits) }
          : {}),
        hint: st.stillApplies
          ? s.status === "approved"
            ? st.kind === "delete"
              ? `Approved. Delete the file in your real checkout${project?.repoUrl ? ` of ${project.repoUrl}` : ""} (git rm "${s.path}"), commit and push — CI mirrors the removal and this closes itself.`
              : `Approved. Apply ${st.kind === "create" ? "this new file" : "these edits"} to your real checkout${project?.repoUrl ? ` of ${project.repoUrl}` : ""}, commit and push — CI mirrors the result. The vault does not write to git.`
            : "Not yet reviewed. review_suggestion approves or rejects it (owner/executive)."
          : st.applied
            ? st.kind === "delete"
              ? "The file is already gone from the mirror — this deletion appears applied."
              : "This appears already applied — the mirror holds exactly the proposed content."
            : "This no longer fits the mirror as it stands. Ask the author to re-read and re-propose.",
      };
    },
  },
  {
    name: "review_suggestion",
    description:
      "Owner/executive only: approve or reject a proposed code change. Approving does NOT modify the mirror or push anything — the vault never writes to git. It marks the change accepted and hands you the edits to apply in your own checkout, which is what makes this safe without storing a git credential.",
    inputSchema: {
      type: "object",
      properties: {
        suggestionId: { type: "string" },
        verdict: { type: "string", enum: ["approve", "reject"] },
        note: { type: "string", description: "required when rejecting — say what would make it acceptable" },
      },
      required: ["suggestionId", "verdict"],
    },
    handler: async (a, ctx) => {
      const { suggestionId, verdict, note } = a as { suggestionId: string; verdict: string; note?: string };
      const approver = requireApprover(ctx);
      const s = await prisma.codeSuggestion.findUnique({ where: { id: suggestionId } });
      if (!s) throw new Error("suggestion not found");
      if (s.status !== "open") throw new Error(`this suggestion is already ${s.status}`);
      if (verdict === "reject" && !note?.trim()) {
        throw new Error("rejecting needs a note — the author cannot act on a bare no");
      }
      const parts = await prisma.codeFile.findMany({ where: { projectId: s.projectId, path: s.path }, orderBy: { part: "asc" } });
      const content = parts.map((p) => p.content).join("");
      const edits = JSON.parse(s.edits) as Edit[];
      const st = suggestionState(parts.length ? content : null, edits, s.baseHash);
      if (verdict === "approve" && !st.stillApplies) {
        throw new Error(
          st.applied
            ? st.kind === "delete"
              ? "the file is already gone from the mirror — this deletion appears applied; nothing to approve."
              : "this appears already applied — the mirror already holds the proposed result; nothing to approve."
            : st.kind === "delete"
              ? "the file changed after this deletion was proposed — what would be removed is not what the author saw. Ask them to confirm and re-propose."
              : st.kind === "create"
                ? "a different file now exists at this path — ask the author to re-propose anchored edits against it."
                : "this no longer fits the current file — the code it anchors to has changed since it was proposed. Ask the author to re-propose against the current version.",
        );
      }
      const updated = await prisma.codeSuggestion.update({
        where: { id: suggestionId },
        data: {
          status: verdict === "approve" ? "approved" : "rejected",
          reviewedBy: approver.username,
          reviewNote: note?.trim() || null,
        },
        select: { id: true, status: true, path: true },
      });
      await prisma.auditEvent.create({
        data: { action: `suggestion_${verdict}`, actor: approver.username, target: s.projectId, detail: `${s.path} (${suggestionId})` },
      });
      const project = await prisma.project.findUnique({ where: { id: s.projectId }, select: { repoUrl: true } });
      return {
        ...updated,
        reviewedBy: approver.username,
        next:
          verdict === "approve"
            ? st.kind === "delete"
              ? `Delete the file in your checkout${project?.repoUrl ? ` of ${project.repoUrl}` : ""} (git rm "${s.path}"), commit and push; CI mirrors the removal and this closes itself.`
              : `get_suggestion { suggestionId: "${suggestionId}", withResult: true } gives you the resulting file. Apply it to your checkout${project?.repoUrl ? ` of ${project.repoUrl}` : ""}, commit and push; CI mirrors it and this closes itself.`
            : `${s.suggestedBy} can revise and propose again.`,
      };
    },
  },
  {
    name: "withdraw_suggestion",
    description:
      "Take back a suggestion you filed, while it is still open — wrong idea, superseded by a better proposal, or filed by mistake. Only the suggester (or an owner/executive) may withdraw, and only while status is open: reviewed suggestions keep their verdict.",
    inputSchema: {
      type: "object",
      properties: {
        suggestionId: { type: "string" },
        reason: { type: "string", description: "optional: why — recorded in the audit trail" },
        actor: { type: "string", description: "who is withdrawing (ignored when authenticated)" },
      },
      required: ["suggestionId"],
    },
    handler: async (a, ctx) => {
      const { suggestionId, reason } = a as { suggestionId: string; reason?: string };
      const actor = actorOf(ctx, (a as { actor?: unknown }).actor);
      const s = await prisma.codeSuggestion.findUnique({ where: { id: suggestionId } });
      if (!s) throw new Error("suggestion not found");
      if (s.status !== "open") throw new Error(`this suggestion is already ${s.status} — only open suggestions can be withdrawn`);
      // The suggester takes back their own; an owner/executive can clear anyone's
      // (a stale proposal from a departed collaborator must not be immortal).
      const acc = ctx?.account;
      const isApprover = Boolean(acc && acc.status === "approved" && (acc.role === "owner" || acc.role === "executive"));
      if (!isApprover && actor !== s.suggestedBy) {
        throw new Error(`only '${s.suggestedBy}' (the suggester) or an owner/executive can withdraw this`);
      }
      const updated = await prisma.codeSuggestion.update({
        where: { id: suggestionId },
        data: { status: "withdrawn", reviewNote: reason?.trim() || null },
        select: { id: true, status: true, path: true },
      });
      await prisma.auditEvent.create({
        data: { action: "withdraw_suggestion", actor, target: s.projectId, detail: `${s.path} (${suggestionId})${reason?.trim() ? ` — ${reason.trim().slice(0, 200)}` : ""}` },
      });
      return { ...updated, by: actor };
    },
  },
  {
    name: "announce_work",
    description:
      "Declare what you are about to do and which files you'll touch, so other agents see it in get_active_work before starting overlapping work. Returns any active intents whose paths overlap yours — check them before proceeding. Update status via update_work when you finish.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        intent: { type: "string", description: "what you're doing, one or two sentences" },
        paths: { type: "array", items: { type: "string" }, description: "repo-relative files you expect to touch" },
        status: { type: "string", enum: [...WORK_STATUSES], default: "in_progress" },
        actor: { type: "string", description: "who is working (ignored when authenticated)" },
      },
      required: ["projectId", "intent"],
    },
    handler: async (a, ctx) => {
      const { projectId, intent, paths, status } = a as {
        projectId: string;
        intent: string;
        paths?: string[];
        status?: string;
      };
      const actor = actorOf(ctx, (a as { actor?: unknown }).actor);
      const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
      if (!project) throw new Error("project not found (use list_projects)");
      if (!intent.trim()) throw new Error("intent required");
      const st = status && (WORK_STATUSES as readonly string[]).includes(status) ? status : "in_progress";
      const cleanPaths = (paths ?? []).filter((p) => typeof p === "string" && isValidRepoPath(p)).map(normalizeRepoPath);

      // Conflict signal: active intents (other actors) touching the same paths.
      const active = await prisma.workIntent.findMany({
        where: { projectId, status: { in: [...ACTIVE_WORK_STATUSES] } },
      });
      const overlapping = active
        .filter((w) => w.actor !== actor)
        .map((w) => ({ id: w.id, actor: w.actor, intent: w.intent, overlap: pathOverlap(cleanPaths, JSON.parse(w.paths) as string[]) }))
        .filter((w) => w.overlap.length > 0);

      const created = await prisma.workIntent.create({
        data: { projectId, actor, intent: intent.trim(), paths: JSON.stringify(cleanPaths), status: st },
      });
      await prisma.auditEvent.create({ data: { action: "announce_work", actor, target: projectId, detail: intent.trim().slice(0, 200) } });
      return {
        intentId: created.id,
        status: created.status,
        by: actor,
        overlapping,
        note: overlapping.length
          ? "CAUTION: other agents are actively working on overlapping files — coordinate before changing them."
          : "No overlapping active work.",
      };
    },
  },
  {
    name: "update_work",
    description:
      "Update a work intent's status: planning | in_progress | in_review | done | abandoned. When you finish coding, sync_code the changed files and set in_review — an owner/executive then approves it via review_work. Do NOT push to git until your intent is approved (status done, reviewedBy set).",
    inputSchema: {
      type: "object",
      properties: { intentId: { type: "string" }, status: { type: "string", enum: [...WORK_STATUSES] } },
      required: ["intentId", "status"],
    },
    handler: async (a, ctx) => {
      const { intentId, status } = a as { intentId: string; status: string };
      if (!(WORK_STATUSES as readonly string[]).includes(status)) {
        throw new Error(`status must be one of: ${WORK_STATUSES.join(", ")}`);
      }
      const actor = actorOf(ctx, (a as { actor?: unknown }).actor);
      const existing = await prisma.workIntent.findUnique({ where: { id: intentId } });
      if (!existing) throw new Error("work intent not found");
      // The merge gate: an authenticated member cannot self-approve. Their path
      // to done runs through in_review + an owner/executive's review_work.
      // (Owner/executive review with their own authority; open/local mode with
      // no accounts is unenforced — the gate needs identity to mean anything.)
      if (status === "done" && ctx?.account && ctx.account.role === "member" && !existing.reviewedBy) {
        throw new Error("review required: set status in_review and have an owner/executive approve via review_work before marking done");
      }
      const updated = await prisma.workIntent.update({
        where: { id: intentId },
        data: { status },
        select: { id: true, status: true, intent: true, reviewedBy: true },
      });
      return { ...updated, by: actor };
    },
  },
  {
    name: "review_work",
    description:
      "Owner/executive only: review a submitted work intent (status in_review). verdict 'approve' marks it done (the actor may then merge/push to git); 'request_changes' sends it back to in_progress with your note. Read the touched files first via read_code / get_code_map.",
    inputSchema: {
      type: "object",
      properties: {
        intentId: { type: "string" },
        verdict: { type: "string", enum: ["approve", "request_changes"] },
        note: { type: "string", description: "feedback for the actor (required for request_changes)" },
      },
      required: ["intentId", "verdict"],
    },
    handler: async (a, ctx) => {
      const approver = requireApprover(ctx);
      const { intentId, verdict, note } = a as { intentId: string; verdict: string; note?: string };
      if (verdict !== "approve" && verdict !== "request_changes") throw new Error("verdict must be approve or request_changes");
      return reviewWorkIntent(intentId, verdict, note, approver);
    },
  },
  {
    name: "get_active_work",
    description:
      "Who is working on what right now: active (planning/in_progress/in_review) work intents with their files, plus recently finished ones. in_review items are the review queue for owners/executives (review_work). Check before you start editing — and cross-reference get_code_map for the latest synced code.",
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "string", description: "omit for all projects" } },
    },
    handler: async (a) => {
      const { projectId } = a as { projectId?: string };
      const where = projectId ? { projectId } : {};
      const [active, recent] = await Promise.all([
        prisma.workIntent.findMany({
          where: { ...where, status: { in: [...ACTIVE_WORK_STATUSES] } },
          orderBy: { updatedAt: "desc" },
          include: { project: { select: { name: true } } },
        }),
        prisma.workIntent.findMany({
          where: { ...where, status: "done" },
          orderBy: { updatedAt: "desc" },
          take: 10,
          include: { project: { select: { name: true } } },
        }),
      ]);
      const shape = (w: (typeof active)[number]) => ({
        intentId: w.id,
        project: w.project.name,
        actor: w.actor,
        intent: w.intent,
        paths: JSON.parse(w.paths) as string[],
        status: w.status,
        reviewedBy: w.reviewedBy,
        reviewNote: w.reviewNote,
        updatedAt: w.updatedAt,
      });
      return {
        active: active.map(shape),
        reviewQueue: active.filter((w) => w.status === "in_review").length,
        recentlyDone: recent.map(shape),
      };
    },
  },
  {
    name: "get_recent_activity",
    description:
      "Everything that changed in the last N hours (default 24): items created/updated, work intents that moved, and audit actions — grouped and attributed. The 'what did everyone do since yesterday' digest; call it at the start of your day/session.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "omit for all projects" },
        sinceHours: { type: "number", default: 24, description: "look-back window in hours (max 720)" },
      },
    },
    handler: async (a) => {
      const { projectId, sinceHours } = a as { projectId?: string; sinceHours?: number };
      const hours = Math.min(Math.max(Number(sinceHours) || 24, 1), 720);
      const since = new Date(Date.now() - hours * 3_600_000);
      const projWhere = projectId ? { projectId } : {};

      const [items, work, audit] = await Promise.all([
        prisma.item.findMany({
          where: { ...projWhere, updatedAt: { gte: since } },
          orderBy: { updatedAt: "desc" },
          take: 50,
          select: {
            id: true, title: true, type: true, status: true, updatedAt: true, createdAt: true,
            project: { select: { name: true } },
          },
        }),
        prisma.workIntent.findMany({
          where: { ...projWhere, updatedAt: { gte: since } },
          orderBy: { updatedAt: "desc" },
          take: 50,
          include: { project: { select: { name: true } } },
        }),
        prisma.auditEvent.findMany({
          where: { createdAt: { gte: since } },
          orderBy: { createdAt: "desc" },
          take: 50,
          select: { action: true, actor: true, target: true, detail: true, createdAt: true },
        }),
      ]);

      return {
        since: since.toISOString(),
        hours,
        items: items.map((i) => ({
          itemId: i.id,
          project: i.project.name,
          title: i.title,
          type: i.type,
          status: i.status,
          isNew: i.createdAt >= since,
          updatedAt: i.updatedAt,
        })),
        work: work.map((w) => ({
          intentId: w.id,
          project: w.project.name,
          actor: w.actor,
          intent: w.intent,
          status: w.status,
          reviewedBy: w.reviewedBy,
          updatedAt: w.updatedAt,
        })),
        audit,
      };
    },
  },

  // ---- Per-project skills: conventions that travel with the project ----
  {
    name: "list_skills",
    description:
      "The working conventions this project expects agents to follow (how to run its tests, its review checklist, its deploy steps). Call this when you start work on a project and follow the ones that apply — they are the team's rules, not suggestions. Returns names + descriptions; use get_skill for the full instructions.",
    inputSchema: { type: "object", properties: { projectId: { type: "string" } }, required: ["projectId"] },
    handler: async (a) => {
      const { projectId } = a as { projectId: string };
      const skills = await prisma.projectSkill.findMany({
        where: { projectId },
        orderBy: { name: "asc" },
        select: { name: true, description: true, updatedBy: true, updatedAt: true },
      });
      return {
        projectId,
        count: skills.length,
        skills,
        hint: skills.length ? "Call get_skill for any whose description matches what you're about to do." : "This project defines no skills yet; set_skill records one.",
      };
    },
  },
  {
    name: "get_skill",
    description: "Read one project skill in full (its instructions as markdown). Follow it for the current task.",
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "string" }, name: { type: "string" } },
      required: ["projectId", "name"],
    },
    handler: async (a) => {
      const { projectId, name } = a as { projectId: string; name: string };
      const skill = await prisma.projectSkill.findUnique({
        where: { projectId_name: { projectId, name: name.trim().toLowerCase() } },
      });
      if (!skill) throw new Error(`no skill '${name}' on this project (use list_skills)`);
      return {
        name: skill.name,
        description: skill.description,
        body: skill.body,
        markdown: toSkillMarkdown(skill),
        updatedBy: skill.updatedBy,
        updatedAt: skill.updatedAt,
      };
    },
  },
  {
    name: "set_skill",
    description:
      "Record or update a working convention for this project so every agent that connects later inherits it. Write it when you learn how this project wants something done — its test command, its release checklist, a trap to avoid. name is kebab-case; description decides when an agent reaches for it, so say WHEN to use it, not just what it is.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        name: { type: "string", description: "kebab-case, e.g. run-tests" },
        description: { type: "string", description: "when to use this — the trigger, not just the topic" },
        body: { type: "string", description: "the instructions, markdown" },
        actor: { type: "string", description: "who is writing it (ignored when authenticated)" },
      },
      required: ["projectId", "name", "description", "body"],
    },
    handler: async (a, ctx) => {
      const { projectId, description, body } = a as { projectId: string; description: string; body: string };
      const name = validateSkillName((a as { name: string }).name);
      const actor = actorOf(ctx, (a as { actor?: unknown }).actor);
      if (!description.trim()) throw new Error("description required — it is what makes an agent reach for the skill");
      if (body.length > MAX_SKILL_BODY) throw new Error(`body must be under ${MAX_SKILL_BODY} characters`);
      const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
      if (!project) throw new Error("project not found (use list_projects)");

      const saved = await prisma.projectSkill.upsert({
        where: { projectId_name: { projectId, name } },
        create: { projectId, name, description: description.trim(), body, createdBy: actor, updatedBy: actor },
        update: { description: description.trim(), body, updatedBy: actor },
        select: { name: true, updatedAt: true },
      });
      await prisma.auditEvent.create({
        data: { action: "set_skill", actor, target: projectId, detail: name },
      });
      return { ...saved, by: actor, note: "Agents connecting to this project now see it in list_skills and in the session-start briefing." };
    },
  },
  {
    name: "delete_skill",
    description: "Remove a project skill. Owner/executive only, since it changes the rules everyone else inherits.",
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "string" }, name: { type: "string" } },
      required: ["projectId", "name"],
    },
    handler: async (a, ctx) => {
      const approver = requireApprover(ctx);
      const { projectId, name } = a as { projectId: string; name: string };
      const gone = await prisma.projectSkill
        .delete({ where: { projectId_name: { projectId, name: name.trim().toLowerCase() } } })
        .catch(() => null);
      if (!gone) throw new Error(`no skill '${name}' on this project`);
      await prisma.auditEvent.create({
        data: { action: "delete_skill", actor: approver.username, target: projectId, detail: gone.name },
      });
      return { deleted: gone.name, by: approver.username };
    },
  },

  // ---- Knowledge-graph traversal (notes + wikilinks) ----
  {
    name: "get_graph",
    description:
      "The project's knowledge graph: note nodes (with link degree) and resolved wikilink edges, plus topLinked — the most-connected notes (the project's central concepts). Traverse from there with get_links / find_path.",
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "string" }, scope: scopeProp },
      required: ["projectId"],
    },
    handler: async (a) => {
      const { projectId, scope } = a as { projectId: string; scope?: string };
      const projectIds = await scopeProjectIds(projectId, scope ?? "project");
      const items = await prisma.item.findMany({
        where: { type: { in: [...CONTENT_TYPES] }, ...(projectIds ? { projectId: { in: projectIds } } : {}) },
        select: { id: true, title: true, type: true, project: { select: { name: true } } },
      });
      const ids = new Set(items.map((i) => i.id));
      const links = await prisma.link.findMany({
        where: { fromItemId: { in: [...ids] }, toItemId: { not: null } },
        select: { fromItemId: true, toItemId: true },
      });
      const edges = links.filter((l) => l.toItemId && ids.has(l.toItemId));
      const degree = new Map<string, number>();
      for (const e of edges) {
        degree.set(e.fromItemId, (degree.get(e.fromItemId) ?? 0) + 1);
        degree.set(e.toItemId!, (degree.get(e.toItemId!) ?? 0) + 1);
      }
      const nodes = items.map((i) => ({
        itemId: i.id,
        title: i.title,
        type: i.type,
        project: i.project.name,
        degree: degree.get(i.id) ?? 0,
      }));
      // Emergent topic clusters (label propagation), each named after its
      // most-connected member — the graph's structure, not just its edges.
      const labels = detectCommunities(nodes.map((n) => n.itemId), edges.map((e) => ({ from: e.fromItemId, to: e.toItemId! })));
      const grouped = new Map<string, typeof nodes>();
      for (const n of nodes) {
        const l = labels.get(n.itemId) ?? n.itemId;
        (grouped.get(l) ?? grouped.set(l, []).get(l)!).push(n);
      }
      const communities = [...grouped.values()]
        .filter((members) => members.length >= 2)
        .map((members) => {
          const sorted = [...members].sort((x, y) => y.degree - x.degree);
          return { label: sorted[0].title, size: members.length, members: sorted.map((m) => ({ itemId: m.itemId, title: m.title })) };
        })
        .sort((a, b) => b.size - a.size);
      return {
        nodeCount: nodes.length,
        edgeCount: edges.length,
        topLinked: [...nodes].sort((x, y) => y.degree - x.degree).slice(0, 10),
        communities,
        nodes,
        edges: edges.map((e) => ({ from: e.fromItemId, to: e.toItemId })),
      };
    },
  },
  {
    name: "suggest_links",
    description:
      "Notes that likely BELONG with this one but were never wikilinked — content-similarity suggestions across connected projects, each explained by the shared terms that drive it. Use to densify the knowledge graph: read the suggestions, then add real [[wikilinks]] where they're right.",
    inputSchema: {
      type: "object",
      properties: { itemId: { type: "string" }, limit: { type: "number", default: 8 } },
      required: ["itemId"],
    },
    handler: async (a) => {
      const { itemId, limit } = a as { itemId: string; limit?: number };
      const item = await prisma.item.findUnique({
        where: { id: itemId },
        select: {
          id: true, title: true, body: true, projectId: true,
          outLinks: { select: { toItemId: true } },
          inLinks: { select: { fromItemId: true } },
        },
      });
      if (!item) throw new Error("item not found");
      const already = new Set([
        item.id,
        ...item.outLinks.map((l) => l.toItemId).filter(Boolean),
        ...item.inLinks.map((l) => l.fromItemId),
      ] as string[]);
      const projectIds = await scopeProjectIds(item.projectId, "connected");
      const candidates = await prisma.item.findMany({
        where: { type: { in: [...CONTENT_TYPES] }, ...(projectIds ? { projectId: { in: projectIds } } : {}) },
        select: { id: true, title: true, body: true, projectId: true, project: { select: { name: true } } },
      });
      const corpus = buildCorpus(candidates.map((c) => ({ id: c.id, projectId: c.projectId, text: simText(c.title, c.body) })));
      const self = corpus.vectors.get(item.id) ?? buildCorpus([{ id: item.id, projectId: item.projectId, text: simText(item.title, item.body) }]).vectors.get(item.id)!;
      const scored = candidates
        .filter((c) => !already.has(c.id))
        .map((c) => ({ c, score: cosine(self, corpus.vectors.get(c.id)!) }))
        .filter((s) => s.score >= 0.12)
        .sort((x, y) => y.score - x.score)
        .slice(0, Math.min(limit ?? 8, 25));
      return {
        itemId: item.id,
        title: item.title,
        suggestions: scored.map(({ c, score }) => ({
          itemId: c.id,
          title: c.title,
          project: c.project.name,
          score: Math.round(score * 100) / 100,
          because: sharedTerms(self, corpus.vectors.get(c.id)!),
        })),
      };
    },
  },
  {
    name: "find_project_bridges",
    description:
      "CANDIDATE project pairs worth a human look, scored by cross-project note similarity with the top note pairs as evidence. Read the evidence before acting: this is lexical (TF-IDF), not semantic, so shared TOOLING reads the same as shared SUBJECT — two unrelated projects that both hit an 'httpx ConnectError' or both call OpenAI will score. A real bridge shows domain words (a character, a client, a product); a false one shows library and error names. Never connect projects on the score alone.",
    inputSchema: { type: "object", properties: { limit: { type: "number", default: 5 } } },
    handler: async (a) => {
      const { limit } = a as { limit?: number };
      const notes = await prisma.item.findMany({
        where: { type: { in: [...CONTENT_TYPES] } },
        select: { id: true, title: true, body: true, projectId: true, project: { select: { name: true } } },
      });
      const projects = new Map(notes.map((n) => [n.projectId, n.project.name]));
      if (projects.size < 2) return { bridges: [], hint: "need at least two projects" };
      const corpus = buildCorpus(notes.map((n) => ({ id: n.id, projectId: n.projectId, text: simText(n.title, n.body) })));

      // Best cross-project note pairs per project pair.
      type Pair = { score: number; evidence: Array<{ a: string; aTitle: string; b: string; bTitle: string; score: number; because: string[] }> };
      const pairs = new Map<string, Pair>();
      for (let i = 0; i < notes.length; i++) {
        for (let j = i + 1; j < notes.length; j++) {
          if (notes[i].projectId === notes[j].projectId) continue;
          const score = cosine(corpus.vectors.get(notes[i].id)!, corpus.vectors.get(notes[j].id)!);
          if (score < 0.15) continue;
          const key = [notes[i].projectId, notes[j].projectId].sort().join("|");
          const p = pairs.get(key) ?? { score: 0, evidence: [] };
          p.evidence.push({
            a: notes[i].id, aTitle: notes[i].title,
            b: notes[j].id, bTitle: notes[j].title,
            score: Math.round(score * 100) / 100,
            because: sharedTerms(corpus.vectors.get(notes[i].id)!, corpus.vectors.get(notes[j].id)!, 4),
          });
          pairs.set(key, p);
        }
      }
      const existing = await prisma.projectRelation.findMany({ select: { fromProjectId: true, toProjectId: true } });
      const connected = new Set(existing.map((r) => [r.fromProjectId, r.toProjectId].sort().join("|")));

      const bridges = [...pairs.entries()]
        .map(([key, p]) => {
          const [pa, pb] = key.split("|");
          const top = p.evidence.sort((x, y) => y.score - x.score).slice(0, 3);
          return {
            projects: [projects.get(pa), projects.get(pb)],
            projectIds: [pa, pb],
            score: Math.round(top.reduce((s, e) => s + e.score, 0) / top.length * 100) / 100,
            alreadyConnected: connected.has(key),
            evidence: top,
          };
        })
        .sort((x, y) => y.score - x.score)
        .slice(0, Math.min(limit ?? 5, 20));
      return { bridges };
    },
  },
  {
    name: "import_notes",
    description:
      "Bulk-import structured content as Obsidian-style linked notes: one note per entry, an optional Map-of-Content that wikilinks them all, keyword cross-links between related notes, and full graph resolution. Creates the project if the name is new. Use for ingesting transcripts, docs, or database exports AFTER you have split them into atomic notes with clear titles. Up to 1000 notes per call; batch beyond that. replace=true wipes the project's existing items first (owner/executive only).",
    inputSchema: {
      type: "object",
      properties: {
        projectName: { type: "string", description: "target project; created if it doesn't exist" },
        description: { type: "string" },
        color: { type: "string", description: "hex like #8b7cf6" },
        notes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              body: { type: "string", description: "markdown; use [[wikilinks]] to other note titles" },
              type: { type: "string", enum: [...CONTENT_TYPES] },
            },
            required: ["title", "body"],
          },
        },
        mocTitle: { type: "string", description: "title for a Map-of-Content index note (recommended)" },
        connectTo: { type: "array", items: { type: "string" }, description: "project names/ids to connect" },
        replace: { type: "boolean", description: "wipe the project's existing items first (owner/executive only)" },
        actor: { type: "string", description: "who is importing (ignored when authenticated)" },
      },
      required: ["projectName", "notes"],
    },
    handler: async (a, ctx) => {
      const parsed = importSchema.safeParse(a);
      if (!parsed.success) throw new Error(`invalid import: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`);
      // Destructive path needs authority; additive imports need none beyond the
      // connection itself (same trust level as append_update).
      if (parsed.data.replace) requireApprover(ctx);
      const actor = actorOf(ctx, (a as { actor?: unknown }).actor);
      const result = await importProject({ ...parsed.data, actor });
      await prisma.auditEvent.create({
        data: {
          action: "import_notes",
          actor,
          target: result.projectId,
          detail: `${result.noteCount} notes into "${parsed.data.projectName}"${parsed.data.replace ? " (replace)" : ""}`,
        },
      });
      return { ...result, by: actor };
    },
  },
  {
    name: "get_links",
    description:
      "One note's neighborhood: outgoing wikilinks (incl. unresolved ghosts) and backlinks (what points here). The single-step traversal primitive — follow ids with read_item or another get_links.",
    inputSchema: { type: "object", properties: { itemId: { type: "string" } }, required: ["itemId"] },
    handler: async (a) => {
      const { itemId } = a as { itemId: string };
      const item = await prisma.item.findUnique({
        where: { id: itemId },
        select: {
          id: true,
          title: true,
          outLinks: { select: { targetTitle: true, toItem: { select: { id: true, title: true, projectId: true } } } },
          inLinks: { select: { fromItem: { select: { id: true, title: true, projectId: true } } } },
        },
      });
      if (!item) throw new Error("item not found");
      return {
        itemId: item.id,
        title: item.title,
        links: item.outLinks.map((l) => ({
          target: l.targetTitle,
          itemId: l.toItem?.id ?? null,
          title: l.toItem?.title ?? null,
          unresolved: !l.toItem,
        })),
        backlinks: item.inLinks.map((l) => ({ itemId: l.fromItem.id, title: l.fromItem.title })),
      };
    },
  },
  {
    name: "find_path",
    description:
      "Shortest wikilink path between two notes (undirected, across connected projects) — how two concepts relate through the notes that join them. Returns the chain of notes or pathFound=false.",
    inputSchema: {
      type: "object",
      properties: { fromItemId: { type: "string" }, toItemId: { type: "string" } },
      required: ["fromItemId", "toItemId"],
    },
    handler: async (a) => {
      const { fromItemId, toItemId } = a as { fromItemId: string; toItemId: string };
      const from = await prisma.item.findUnique({ where: { id: fromItemId }, select: { projectId: true } });
      if (!from) throw new Error("fromItemId not found");
      const projectIds = await scopeProjectIds(from.projectId, "connected");
      const items = await prisma.item.findMany({
        where: projectIds ? { projectId: { in: projectIds } } : {},
        select: { id: true, title: true },
      });
      const titleOf = new Map(items.map((i) => [i.id, i.title]));
      const links = await prisma.link.findMany({
        where: { fromItemId: { in: [...titleOf.keys()] }, toItemId: { not: null } },
        select: { fromItemId: true, toItemId: true },
      });
      const adj = new Map<string, string[]>();
      for (const l of links) {
        if (!titleOf.has(l.toItemId!)) continue;
        (adj.get(l.fromItemId) ?? adj.set(l.fromItemId, []).get(l.fromItemId)!).push(l.toItemId!);
        (adj.get(l.toItemId!) ?? adj.set(l.toItemId!, []).get(l.toItemId!)!).push(l.fromItemId);
      }
      // BFS, undirected.
      const prev = new Map<string, string>();
      const queue = [fromItemId];
      const seen = new Set([fromItemId]);
      while (queue.length) {
        const cur = queue.shift()!;
        if (cur === toItemId) {
          const path: string[] = [];
          for (let n = toItemId; ; n = prev.get(n)!) {
            path.unshift(n);
            if (n === fromItemId) break;
          }
          return { pathFound: true, hops: path.length - 1, path: path.map((id) => ({ itemId: id, title: titleOf.get(id) ?? "?" })) };
        }
        for (const next of adj.get(cur) ?? []) {
          if (!seen.has(next)) {
            seen.add(next);
            prev.set(next, cur);
            queue.push(next);
          }
        }
      }
      return { pathFound: false, hint: "no wikilink chain connects these notes within connected projects" };
    },
  },
];

export const toolMap = new Map(tools.map((t) => [t.name, t]));

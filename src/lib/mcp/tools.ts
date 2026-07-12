import { prisma } from "../db";
import { detectSignals } from "../attention";
import { rollup, rollupConnected, rollupMany } from "../status";
import { scopeProjectIds } from "../projects";
import { buildTemplatedBriefing } from "../briefing/templated";
import { ITEM_STATUSES, CONTENT_TYPES, importSchema } from "../validation";
import { importProject } from "../import";
import { approveAccount, setRole } from "../accounts";
import { MAX_SYNC_FILES, MAX_FILE_CHARS, WORK_STATUSES, ACTIVE_WORK_STATUSES, isValidRepoPath, normalizeRepoPath, hashContent, pathOverlap } from "../code";
import { reviewWorkIntent } from "../work";
import { buildCorpus, cosine, sharedTerms, detectCommunities } from "../related";

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
      "List the areas needing attention (overdue, blocked, open risks, due-soon, stale) for a project/scope. Each signal cites the source item id so you can read_item for detail. Cross-project flags raised via flag_issue show up here too.",
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
    description: "Full-text search items by title/body within a project, connected projects, or all.",
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
      return prisma.item.findMany({
        where: {
          type: { in: [...CONTENT_TYPES] },
          ...(ids ? { projectId: { in: ids } } : {}),
          OR: [{ title: { contains: query } }, { body: { contains: query } }],
        },
        take: 20,
        orderBy: { updatedAt: "desc" },
        select: { id: true, title: true, type: true, status: true, projectId: true },
      });
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
        .update({ where: { id: itemId }, data: { status, closedAt }, select: { id: true, status: true, updatedAt: true } })
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
        },
        select: { id: true, projectId: true, createdAt: true },
      });
      return { ...item, from, to: target.username, note: `Sent to @${target.username}; they will see it in get_inbox.` };
    },
  },
  {
    name: "get_inbox",
    description: "List open items addressed to YOU — cross-project flags and info requests assigned to your account. Requires an approved identity.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_a, ctx) => {
      if (!ctx?.account) throw new Error("no identity — connect with your approved account token to use get_inbox");
      return prisma.item.findMany({
        where: { assigneeAccountId: ctx.account.id, closedAt: null },
        orderBy: { createdAt: "desc" },
        select: { id: true, projectId: true, type: true, status: true, title: true, createdAt: true },
      });
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
      "Push file snapshots into the project's shared code mirror so other agents can browse them (get_code_map / read_code) without pulling git. Send only changed files (compare hashes via get_code_map first). Max 100 files per call, 200k chars per file.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        ref: { type: "string", description: "branch/commit label, e.g. 'main @ 7a2766e' (optional)" },
        files: {
          type: "array",
          items: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
            required: ["path", "content"],
          },
        },
        deletes: { type: "array", items: { type: "string" }, description: "paths removed from the repo" },
        actor: { type: "string", description: "who is syncing (ignored when authenticated)" },
      },
      required: ["projectId", "files"],
    },
    handler: async (a, ctx) => {
      const { projectId, ref, files, deletes } = a as {
        projectId: string;
        ref?: string;
        files: Array<{ path: string; content: string }>;
        deletes?: string[];
      };
      const actor = actorOf(ctx, (a as { actor?: unknown }).actor);
      const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
      if (!project) throw new Error("project not found (use list_projects)");
      if (!Array.isArray(files) || files.length > MAX_SYNC_FILES) {
        throw new Error(`files must be an array of at most ${MAX_SYNC_FILES}; sync in batches`);
      }

      const skipped: Array<{ path: string; reason: string }> = [];
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
        if (f.content.length > MAX_FILE_CHARS) {
          skipped.push({ path: f.path, reason: `over ${MAX_FILE_CHARS} chars` });
          continue;
        }
        const path = normalizeRepoPath(f.path);
        const data = {
          content: f.content,
          hash: hashContent(f.content),
          size: f.content.length,
          ref: ref ?? null,
          syncedBy: actor,
        };
        await prisma.codeFile.upsert({
          where: { projectId_path: { projectId, path } },
          create: { projectId, path, ...data },
          update: data,
        });
        synced++;
      }

      let deleted = 0;
      for (const d of deletes ?? []) {
        if (typeof d !== "string" || !isValidRepoPath(d)) continue;
        const r = await prisma.codeFile.deleteMany({ where: { projectId, path: normalizeRepoPath(d) } });
        deleted += r.count;
      }

      await prisma.auditEvent.create({
        data: { action: "sync_code", actor, target: projectId, detail: `${synced} synced, ${deleted} deleted${ref ? ` @ ${ref}` : ""}` },
      });
      return { synced, deleted, skipped, by: actor };
    },
  },
  {
    name: "get_code_map",
    description:
      "The project's shared code mirror as a tree: every synced file's path, content hash, size, ref, who synced it and when. Diff hashes against your local files to know what changed without reading contents.",
    inputSchema: { type: "object", properties: { projectId: { type: "string" } }, required: ["projectId"] },
    handler: async (a) => {
      const { projectId } = a as { projectId: string };
      const files = await prisma.codeFile.findMany({
        where: { projectId },
        orderBy: { path: "asc" },
        select: { path: true, hash: true, size: true, ref: true, syncedBy: true, updatedAt: true },
      });
      return { projectId, fileCount: files.length, files };
    },
  },
  {
    name: "read_code",
    description: "Read one file from the project's shared code mirror (synced by agents via sync_code).",
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "string" }, path: { type: "string" } },
      required: ["projectId", "path"],
    },
    handler: async (a) => {
      const { projectId, path } = a as { projectId: string; path: string };
      const file = await prisma.codeFile.findUnique({
        where: { projectId_path: { projectId, path: normalizeRepoPath(path) } },
      });
      if (!file) throw new Error("file not in the mirror (see get_code_map; an agent may need to sync_code it)");
      return { path: file.path, content: file.content, hash: file.hash, ref: file.ref, syncedBy: file.syncedBy, updatedAt: file.updatedAt };
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
      "Which projects share concepts — before anyone connects them. Scores every project pair by cross-project note similarity and existing cross-links, with the top note pairs as evidence. The 'how does our work connect' question, answered from content.",
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
      const result = await importProject(parsed.data);
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

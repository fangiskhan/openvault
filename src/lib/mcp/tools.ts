import { prisma } from "../db";
import { detectSignals } from "../attention";
import { rollup, rollupConnected, rollupMany } from "../status";
import { scopeProjectIds } from "../projects";
import { buildTemplatedBriefing } from "../briefing/templated";
import { ITEM_STATUSES, CONTENT_TYPES } from "../validation";

export type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
};

const scopeProp = { type: "string", enum: ["project", "connected", "all"], default: "project" };

async function allProjectIds(): Promise<string[]> {
  return (await prisma.project.findMany({ select: { id: true } })).map((p) => p.id);
}

export const tools: Tool[] = [
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
      "List the areas needing attention (overdue, blocked, open risks, due-soon, stale) for a project/scope. Each signal cites the source item id so you can read_item for detail.",
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
      "Set the status of a task (open|blocked|done) or risk (open|mitigating|accepted|closed). Records who changed it (actor) and when. This is how an agent updates shared state that other agents will read on their next get_status.",
    inputSchema: {
      type: "object",
      properties: {
        itemId: { type: "string" },
        status: { type: "string", enum: [...ITEM_STATUSES] },
        actor: { type: "string", description: "who is making the change (agent or user name)" },
      },
      required: ["itemId", "status"],
    },
    handler: async (a) => {
      const { itemId, status, actor = "agent" } = a as { itemId: string; status: string; actor?: string };
      const it = await prisma.item.findUnique({ where: { id: itemId }, select: { metadata: true } });
      if (!it) throw new Error("item not found");
      const meta = it.metadata ? JSON.parse(it.metadata) : {};
      meta.lastStatusBy = actor;
      meta.lastStatusVia = "mcp";
      const closedAt = status === "done" || status === "closed" || status === "accepted" ? new Date() : null;
      const updated = await prisma.item.update({
        where: { id: itemId },
        data: { status, closedAt, metadata: JSON.stringify(meta) },
        select: { id: true, status: true, updatedAt: true },
      });
      return { ...updated, by: actor };
    },
  },
  {
    name: "append_update",
    description:
      "Append an attributed status update to a project — a short note other agents and humans will see in 'recently updated'. Use this to record progress without a human handover.",
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "string" }, text: { type: "string" }, actor: { type: "string" } },
      required: ["projectId", "text"],
    },
    handler: async (a) => {
      const { projectId, text, actor = "agent" } = a as { projectId: string; text: string; actor?: string };
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
];

export const toolMap = new Map(tools.map((t) => [t.name, t]));

import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { scopeProjectIds } from "@/lib/projects";
import { searchScopeSchema, CONTENT_TYPES } from "@/lib/validation";

export async function GET(req: Request) {
  const denied = await requireAuth();
  if (denied) return denied;

  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId");
  const scope = searchScopeSchema.parse(url.searchParams.get("scope") || "project");
  const projectIds = await scopeProjectIds(projectId, scope);

  const items = await prisma.item.findMany({
    where: {
      type: { in: [...CONTENT_TYPES] },
      ...(projectIds ? { projectId: { in: projectIds } } : {}),
    },
    select: { id: true, title: true, type: true, projectId: true, project: { select: { color: true } } },
  });
  const itemIds = new Set(items.map((i) => i.id));

  const links = await prisma.link.findMany({
    where: { fromItemId: { in: [...itemIds] }, toItemId: { not: null } },
    select: { fromItemId: true, toItemId: true },
  });

  return Response.json({
    nodes: items.map((i) => ({
      id: i.id,
      label: i.title,
      type: i.type,
      projectId: i.projectId,
      color: i.project.color ?? "#8b7cf6",
    })),
    edges: links
      .filter((l) => l.toItemId && itemIds.has(l.toItemId))
      .map((l) => ({ source: l.fromItemId, target: l.toItemId! })),
  });
}

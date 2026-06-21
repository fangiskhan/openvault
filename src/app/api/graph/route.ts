import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { scopeProjectIds } from "@/lib/projects";
import { searchScopeSchema, CONTENT_TYPES } from "@/lib/validation";

// Distinct, dark-theme-friendly hues used to break ties when projects share a
// stored color (imported projects all default to the same one), so the
// whole-vault graph can actually be read as "one color per project".
const GRAPH_PALETTE = [
  "#8b7cf6", "#6aa3ff", "#5fb3a1", "#d08770", "#e0a458", "#c678dd",
  "#56b6c2", "#e06c9f", "#98c379", "#7aa2f7", "#bb9af7", "#d19a66",
];

function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

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
    select: {
      id: true,
      title: true,
      type: true,
      projectId: true,
      project: { select: { id: true, name: true, color: true } },
    },
  });
  const itemIds = new Set(items.map((i) => i.id));

  const links = await prisma.link.findMany({
    where: { fromItemId: { in: [...itemIds] }, toItemId: { not: null } },
    select: { fromItemId: true, toItemId: true },
  });

  // Distinct projects represented in the node set, in a stable (name) order.
  const seen = new Map<string, { id: string; name: string; storedColor: string }>();
  for (const i of items) {
    if (!seen.has(i.projectId)) {
      seen.set(i.projectId, {
        id: i.projectId,
        name: i.project.name,
        storedColor: i.project.color ?? GRAPH_PALETTE[0],
      });
    }
  }
  const ordered = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));

  // Resolve a DISTINCT color per project. Pass 1: each project keeps its own
  // color, first claimant winning a collision. Pass 2: projects whose color was
  // already taken get a fresh palette hue (never reusing any stored color), so
  // the whole-vault legend has one unambiguous color per project.
  const colorByProject = new Map<string, string>();
  const used = new Set<string>();
  const deferred: typeof ordered = [];
  for (const p of ordered) {
    if (used.has(p.storedColor)) {
      deferred.push(p);
    } else {
      used.add(p.storedColor);
      colorByProject.set(p.id, p.storedColor);
    }
  }
  let next = 0;
  for (const p of deferred) {
    while (next < GRAPH_PALETTE.length && used.has(GRAPH_PALETTE[next])) next++;
    const color = next < GRAPH_PALETTE.length ? GRAPH_PALETTE[next] : `hsl(${hashHue(p.id)}, 62%, 62%)`;
    used.add(color);
    colorByProject.set(p.id, color);
  }

  return Response.json({
    nodes: items.map((i) => ({
      id: i.id,
      label: i.title,
      type: i.type,
      projectId: i.projectId,
      color: colorByProject.get(i.projectId)!,
    })),
    edges: links
      .filter((l) => l.toItemId && itemIds.has(l.toItemId))
      .map((l) => ({ source: l.fromItemId, target: l.toItemId! })),
    projects: ordered.map((p) => ({ id: p.id, name: p.name, color: colorByProject.get(p.id)! })),
  });
}

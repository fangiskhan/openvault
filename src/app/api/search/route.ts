import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { scopeProjectIds } from "@/lib/projects";
import { searchScopeSchema } from "@/lib/validation";

export async function GET(req: Request) {
  const denied = await requireAuth();
  if (denied) return denied;

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim();
  const projectId = url.searchParams.get("projectId");
  const scope = searchScopeSchema.parse(url.searchParams.get("scope") || "project");
  if (!q) return Response.json({ results: [] });

  const projectIds = await scopeProjectIds(projectId, scope);

  // On SQLite, `contains` compiles to LIKE, which is case-insensitive for ASCII.
  // On Postgres, add `mode: "insensitive"` for the same behaviour.
  const items = await prisma.item.findMany({
    where: {
      ...(projectIds ? { projectId: { in: projectIds } } : {}),
      OR: [{ title: { contains: q } }, { body: { contains: q } }],
    },
    orderBy: { updatedAt: "desc" },
    take: 30,
    select: {
      id: true,
      title: true,
      type: true,
      body: true,
      projectId: true,
      project: { select: { name: true, color: true } },
    },
  });

  return Response.json({
    results: items.map((it) => ({
      id: it.id,
      title: it.title,
      type: it.type,
      projectId: it.projectId,
      projectName: it.project.name,
      projectColor: it.project.color,
      snippet: snippet(it.body, q),
    })),
  });
}

function snippet(body: string, q: string): string {
  const i = body.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return body.slice(0, 140).replace(/\n/g, " ");
  const start = Math.max(0, i - 50);
  return (start > 0 ? "…" : "") + body.slice(start, start + 140).replace(/\n/g, " ");
}

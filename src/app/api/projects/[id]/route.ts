import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { updateProjectSchema, CONTENT_TYPES } from "@/lib/validation";
import { badRequest, notFound } from "@/lib/http";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const denied = await requireAuth();
  if (denied) return denied;
  const { id } = await params;

  const project = await prisma.project.findUnique({
    where: { id },
    include: {
      // risk/briefing items have their own surfaces — keep them out of the Notes list.
      items: {
        where: { type: { in: [...CONTENT_TYPES] } },
        orderBy: { updatedAt: "desc" },
        select: { id: true, title: true, type: true, updatedAt: true },
      },
      relationsFrom: { include: { toProject: { select: { id: true, name: true, color: true, slug: true } } } },
      relationsTo: { include: { fromProject: { select: { id: true, name: true, color: true, slug: true } } } },
    },
  });
  if (!project) return notFound();

  const connections = [
    ...project.relationsFrom.map((r) => ({ ...r.toProject, kind: r.kind })),
    ...project.relationsTo.map((r) => ({ ...r.fromProject, kind: r.kind })),
  ];

  return Response.json({
    id: project.id,
    slug: project.slug,
    name: project.name,
    description: project.description,
    color: project.color,
    health: project.health,
    healthNote: project.healthNote,
    items: project.items,
    connections,
  });
}

export async function PATCH(req: Request, { params }: Ctx) {
  const denied = await requireAuth();
  if (denied) return denied;
  const { id } = await params;

  const parsed = updateProjectSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error.flatten());

  const data: Record<string, unknown> = { ...parsed.data };
  // Stamp when the manual RAG override is set/cleared.
  if ("health" in data) data.healthSetAt = data.health ? new Date() : null;

  const project = await prisma.project.update({ where: { id }, data }).catch(() => null);
  if (!project) return notFound();
  return Response.json(project);
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const denied = await requireAuth();
  if (denied) return denied;
  const { id } = await params;
  await prisma.project.delete({ where: { id } }).catch(() => null);
  return Response.json({ ok: true });
}

import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { updateItemSchema } from "@/lib/validation";
import { syncItemLinks, resolveGhostLinks } from "@/lib/links";
import { badRequest, notFound } from "@/lib/http";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const denied = await requireAuth();
  if (denied) return denied;
  const { id } = await params;

  const item = await prisma.item.findUnique({
    where: { id },
    include: {
      project: { select: { id: true, name: true, color: true } },
      outLinks: { include: { toItem: { select: { id: true, title: true, projectId: true } } } },
    },
  });
  if (!item) return notFound();

  // Backlinks = resolved links pointing here + ghost links matching this title.
  const backlinks = await prisma.link.findMany({
    where: { OR: [{ toItemId: id }, { toItemId: null, targetTitle: { equals: item.title } }] },
    include: {
      fromItem: {
        select: { id: true, title: true, projectId: true, project: { select: { name: true, color: true } } },
      },
    },
  });

  const seen = new Set<string>([id]);
  const related: Array<{ id: string; title: string; projectId: string; projectName: string; projectColor: string | null }> = [];
  for (const b of backlinks) {
    if (seen.has(b.fromItem.id)) continue;
    seen.add(b.fromItem.id);
    related.push({
      id: b.fromItem.id,
      title: b.fromItem.title,
      projectId: b.fromItem.projectId,
      projectName: b.fromItem.project.name,
      projectColor: b.fromItem.project.color,
    });
  }

  return Response.json({
    id: item.id,
    projectId: item.projectId,
    project: item.project,
    type: item.type,
    source: item.source,
    title: item.title,
    body: item.body,
    metadata: item.metadata ? JSON.parse(item.metadata) : null,
    updatedAt: item.updatedAt,
    links: item.outLinks.map((l) => ({ targetTitle: l.targetTitle, toItem: l.toItem })),
    backlinks: related,
  });
}

export async function PATCH(req: Request, { params }: Ctx) {
  const denied = await requireAuth();
  if (denied) return denied;
  const { id } = await params;

  const parsed = updateItemSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error.flatten());

  const existing = await prisma.item.findUnique({ where: { id }, select: { projectId: true, title: true } });
  if (!existing) return notFound();

  const item = await prisma.item.update({ where: { id }, data: parsed.data });

  if (parsed.data.body !== undefined) {
    await syncItemLinks(item.id, item.projectId, item.body);
  }
  if (parsed.data.title !== undefined && parsed.data.title !== existing.title) {
    await resolveGhostLinks(item.id, item.projectId, item.title);
  }
  return Response.json(item);
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const denied = await requireAuth();
  if (denied) return denied;
  const { id } = await params;
  await prisma.item.delete({ where: { id } }).catch(() => null);
  return Response.json({ ok: true });
}

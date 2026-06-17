import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { createItemSchema } from "@/lib/validation";
import { syncItemLinks, resolveGhostLinks } from "@/lib/links";
import { badRequest } from "@/lib/http";

export async function POST(req: Request) {
  const denied = await requireAuth();
  if (denied) return denied;

  const parsed = createItemSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error.flatten());
  const { projectId, title, body, type } = parsed.data;

  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
  if (!project) return badRequest("unknown projectId");

  const item = await prisma.item.create({
    data: { projectId, title, body: body ?? "", type: type ?? "note" },
  });
  await syncItemLinks(item.id, projectId, item.body);
  await resolveGhostLinks(item.id, projectId, item.title);

  return Response.json(item, { status: 201 });
}

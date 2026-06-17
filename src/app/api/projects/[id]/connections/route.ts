import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { connectSchema } from "@/lib/validation";
import { badRequest } from "@/lib/http";

type Ctx = { params: Promise<{ id: string }> };

// Connections are undirected for v1: we store the pair in sorted order so
// (A,B) and (B,A) are the same row.
function pair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

export async function POST(req: Request, { params }: Ctx) {
  const denied = await requireAuth();
  if (denied) return denied;
  const { id } = await params;

  const parsed = connectSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error.flatten());
  const { toProjectId, kind } = parsed.data;
  if (toProjectId === id) return badRequest("cannot connect a project to itself");

  const other = await prisma.project.findUnique({ where: { id: toProjectId }, select: { id: true } });
  if (!other) return badRequest("unknown toProjectId");

  const [a, b] = pair(id, toProjectId);
  const rel = await prisma.projectRelation.upsert({
    where: { fromProjectId_toProjectId: { fromProjectId: a, toProjectId: b } },
    create: { fromProjectId: a, toProjectId: b, kind: kind ?? "related" },
    update: { kind: kind ?? "related" },
  });
  return Response.json(rel, { status: 201 });
}

export async function DELETE(req: Request, { params }: Ctx) {
  const denied = await requireAuth();
  if (denied) return denied;
  const { id } = await params;
  const to = new URL(req.url).searchParams.get("to");
  if (!to) return badRequest("missing ?to=");
  const [a, b] = pair(id, to);
  await prisma.projectRelation.deleteMany({ where: { fromProjectId: a, toProjectId: b } });
  return Response.json({ ok: true });
}

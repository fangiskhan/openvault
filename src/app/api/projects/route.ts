import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { createProjectSchema } from "@/lib/validation";
import { slugify, uniqueSlug } from "@/lib/slug";
import { badRequest } from "@/lib/http";

export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;

  const projects = await prisma.project.findMany({
    orderBy: { updatedAt: "desc" },
    include: { _count: { select: { items: true } } },
  });

  return Response.json(
    projects.map((p) => ({
      id: p.id,
      slug: p.slug,
      name: p.name,
      description: p.description,
      color: p.color,
      itemCount: p._count.items,
      updatedAt: p.updatedAt,
    })),
  );
}

export async function POST(req: Request) {
  const denied = await requireAuth();
  if (denied) return denied;

  const parsed = createProjectSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error.flatten());

  const existing = await prisma.project.findMany({ select: { slug: true } });
  const slug = uniqueSlug(slugify(parsed.data.name), new Set(existing.map((e) => e.slug)));

  const project = await prisma.project.create({ data: { ...parsed.data, slug } });
  return Response.json(project, { status: 201 });
}

import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

// GET /api/export?projectId=<id>  — full JSON export of one project (omit
// projectId for the whole vault). Lets a self-hosted team back up or take their
// data out. Guarded by the human auth gate.
export async function GET(req: Request) {
  const denied = await requireAuth();
  if (denied) return denied;

  const projectId = new URL(req.url).searchParams.get("projectId");

  const projects = await prisma.project.findMany({
    where: projectId ? { id: projectId } : {},
    include: {
      items: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          type: true,
          source: true,
          title: true,
          body: true,
          status: true,
          dueAt: true,
          closedAt: true,
          metadata: true,
          createdAt: true,
          updatedAt: true,
        },
      },
    },
  });

  const projectIds = new Set(projects.map((p) => p.id));
  const relations = (await prisma.projectRelation.findMany()).filter(
    (r) => projectIds.has(r.fromProjectId) && projectIds.has(r.toProjectId),
  );

  const payload = {
    format: "openvault-export/v1",
    exportedAt: new Date().toISOString(),
    projectCount: projects.length,
    projects,
    relations,
  };

  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      "content-type": "application/json",
      "content-disposition": `attachment; filename="openvault-export-${projectId ?? "all"}.json"`,
    },
  });
}

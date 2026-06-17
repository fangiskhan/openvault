import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { scopeProjectIds } from "@/lib/projects";
import { detectSignals } from "@/lib/attention";
import { searchScopeSchema } from "@/lib/validation";

export async function GET(req: Request) {
  const denied = await requireAuth();
  if (denied) return denied;

  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId");
  const scope = searchScopeSchema.parse(url.searchParams.get("scope") || "project");

  let projectIds = await scopeProjectIds(projectId, scope);
  if (projectIds === null) {
    projectIds = (await prisma.project.findMany({ select: { id: true } })).map((p) => p.id);
  }

  const signals = await detectSignals(projectIds);
  return Response.json({ signals });
}

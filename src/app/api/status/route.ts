import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { rollup, rollupMany, rollupConnected } from "@/lib/status";
import { searchScopeSchema } from "@/lib/validation";

export async function GET(req: Request) {
  const denied = await requireAuth();
  if (denied) return denied;

  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId");
  const scope = searchScopeSchema.parse(url.searchParams.get("scope") || "project");

  if (scope === "all") {
    const ids = (await prisma.project.findMany({ select: { id: true } })).map((p) => p.id);
    return Response.json(await rollupMany(ids));
  }
  if (!projectId) return Response.json({ error: "projectId required" }, { status: 400 });
  if (scope === "connected") return Response.json(await rollupConnected(projectId));

  const r = await rollup(projectId);
  return Response.json({ headline: r.computed, projects: [r] });
}

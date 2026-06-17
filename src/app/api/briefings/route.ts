import { requireAuth } from "@/lib/auth";
import { searchScopeSchema } from "@/lib/validation";
import { buildTemplatedBriefing } from "@/lib/briefing/templated";

export async function GET(req: Request) {
  const denied = await requireAuth();
  if (denied) return denied;

  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId");
  const scope = searchScopeSchema.parse(url.searchParams.get("scope") || "project");
  if (!projectId) return Response.json({ error: "projectId required" }, { status: 400 });

  const doc = await buildTemplatedBriefing(projectId, scope);
  return Response.json(doc);
}

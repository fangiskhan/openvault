import { requireAuth } from "@/lib/auth";
import { scopeProjectIds } from "@/lib/projects";
import { searchScopeSchema } from "@/lib/validation";
import { searchItems, snippet } from "@/lib/search";

// Same ranked implementation the search MCP tool uses, so the browser and
// agents never disagree about what the vault contains.
export async function GET(req: Request) {
  const denied = await requireAuth();
  if (denied) return denied;

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim();
  const projectId = url.searchParams.get("projectId");
  const scope = searchScopeSchema.parse(url.searchParams.get("scope") || "project");
  if (!q) return Response.json({ results: [] });

  const projectIds = await scopeProjectIds(projectId, scope);
  const hits = await searchItems(q, projectIds, 30);

  return Response.json({
    results: hits.map((it) => ({
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

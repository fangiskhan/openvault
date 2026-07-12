import { requireAuth } from "@/lib/auth";
import { toolMap } from "@/lib/mcp/tools";
import { badRequest } from "@/lib/http";

// GET /api/related?itemId= — the Related rail: content-similarity suggestions
// for the open note. Same implementation as the suggest_links MCP tool.
export async function GET(req: Request) {
  const denied = await requireAuth();
  if (denied) return denied;

  const itemId = new URL(req.url).searchParams.get("itemId");
  if (!itemId) return badRequest("missing itemId");
  try {
    const result = await toolMap.get("suggest_links")!.handler({ itemId, limit: 6 }, { account: null });
    return Response.json(result);
  } catch (e) {
    return badRequest((e as Error).message);
  }
}

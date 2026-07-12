import { approverFrom } from "@/lib/accounts";
import { reviewWorkIntent } from "@/lib/work";
import { badRequest } from "@/lib/http";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/work/[id]/review { verdict: "approve" | "request_changes", note? }
// Same gate and same implementation as the review_work MCP tool — an
// owner/executive (session or bearer) decides whether the work may land in git.
export async function POST(req: Request, { params }: Ctx) {
  const approver = await approverFrom(req);
  if (!approver) return Response.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;
  const data = (await req.json().catch(() => ({}))) as { verdict?: unknown; note?: unknown };
  if (data.verdict !== "approve" && data.verdict !== "request_changes") {
    return badRequest("verdict must be approve or request_changes");
  }
  try {
    const result = await reviewWorkIntent(
      id,
      data.verdict,
      typeof data.note === "string" ? data.note : undefined,
      { username: approver.username },
    );
    return Response.json(result);
  } catch (e) {
    return badRequest((e as Error).message);
  }
}

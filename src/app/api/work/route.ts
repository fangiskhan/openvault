import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { ACTIVE_WORK_STATUSES } from "@/lib/code";
import { badRequest } from "@/lib/http";

// GET /api/work?projectId= — the work board: active intents (incl. the review
// queue) and recently finished ones, for the Code tab.
export async function GET(req: Request) {
  const denied = await requireAuth();
  if (denied) return denied;

  const projectId = new URL(req.url).searchParams.get("projectId");
  if (!projectId) return badRequest("missing projectId");

  const [active, recent] = await Promise.all([
    prisma.workIntent.findMany({
      where: { projectId, status: { in: [...ACTIVE_WORK_STATUSES] } },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.workIntent.findMany({
      where: { projectId, status: "done" },
      orderBy: { updatedAt: "desc" },
      take: 10,
    }),
  ]);

  const shape = (w: (typeof active)[number]) => ({
    intentId: w.id,
    actor: w.actor,
    intent: w.intent,
    paths: JSON.parse(w.paths) as string[],
    status: w.status,
    reviewedBy: w.reviewedBy,
    reviewNote: w.reviewNote,
    updatedAt: w.updatedAt,
  });
  return Response.json({ active: active.map(shape), recentlyDone: recent.map(shape) });
}

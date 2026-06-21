import { prisma } from "@/lib/db";
import { approverFrom } from "@/lib/accounts";

// GET: the append-only accountability log (who approved whom, etc.).
// Owner/executive only.
export async function GET(req: Request) {
  const approver = await approverFrom(req);
  if (!approver) return Response.json({ error: "forbidden" }, { status: 403 });
  const events = await prisma.auditEvent.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
  return Response.json(events);
}

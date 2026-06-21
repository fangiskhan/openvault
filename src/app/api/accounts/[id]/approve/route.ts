import { approverFrom, approveAccount } from "@/lib/accounts";

type Ctx = { params: Promise<{ id: string }> };

// POST: approve a pending account. Owner/executive only. Records the approver
// permanently (approvedById + approvedAt + an AuditEvent).
export async function POST(req: Request, { params }: Ctx) {
  const approver = await approverFrom(req);
  if (!approver) return Response.json({ error: "forbidden — owner/executive only" }, { status: 403 });
  const { id } = await params;
  try {
    const a = await approveAccount(id, approver);
    return Response.json({
      id: a.id,
      username: a.username,
      status: a.status,
      approvedById: a.approvedById,
      approvedAt: a.approvedAt,
      approvedBy: approver.username,
    });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}

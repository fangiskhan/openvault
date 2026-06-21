import { approverFrom, setRole } from "@/lib/accounts";

type Ctx = { params: Promise<{ id: string }> };

// POST { role: "executive" | "member" }: grant or revoke approving rights.
// Owner only.
export async function POST(req: Request, { params }: Ctx) {
  const approver = await approverFrom(req);
  if (!approver || approver.role !== "owner") return Response.json({ error: "owner only" }, { status: 403 });
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { role?: unknown };
  if (body.role !== "executive" && body.role !== "member") {
    return Response.json({ error: "role must be 'executive' or 'member'" }, { status: 400 });
  }
  try {
    const a = await setRole(id, body.role, approver);
    return Response.json({ id: a.id, username: a.username, role: a.role });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}

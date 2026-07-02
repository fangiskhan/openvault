import { approverFrom, regenerateToken } from "@/lib/accounts";
import { badRequest } from "@/lib/http";

type Ctx = { params: Promise<{ id: string }> };

// POST: re-issue an account's bearer token (owner/executive only). Tokens are
// stored hashed, so this is the ONLY way to get a usable token after the
// registration response is gone. Old token dies immediately; new plaintext is
// returned exactly once.
export async function POST(req: Request, { params }: Ctx) {
  const approver = await approverFrom(req);
  if (!approver) return Response.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  try {
    const { account, token } = await regenerateToken(id, { username: approver.username });
    return Response.json({
      id: account.id,
      username: account.username,
      token,
      note: "SAVE THIS TOKEN — it is shown once and stored only as a hash.",
    });
  } catch (e) {
    return badRequest((e as Error).message);
  }
}

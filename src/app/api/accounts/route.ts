import { prisma } from "@/lib/db";
import { registerAccount, approverFrom } from "@/lib/accounts";
import { badRequest } from "@/lib/http";
import { rateLimit, clientKey, tooMany } from "@/lib/ratelimit";

// POST: request an account (anyone). Created as pending; the returned token is
// inert until an owner/executive approves it.
export async function POST(req: Request) {
  // Open registration endpoint: stop pending-queue flooding.
  if (!rateLimit(`register:${clientKey(req)}`, 5, 3_600_000)) return tooMany("too many registrations; try later");
  const data = (await req.json().catch(() => ({}))) as { username?: unknown; displayName?: unknown };
  if (typeof data.username !== "string") return badRequest("username required");
  try {
    const { account: a, token } = await registerAccount(
      data.username.trim(),
      typeof data.displayName === "string" ? data.displayName.trim() : undefined,
    );
    return Response.json(
      {
        id: a.id,
        username: a.username,
        status: a.status,
        token,
        note: "SAVE THIS TOKEN — it is shown once and stored only as a hash. Present it as 'Authorization: Bearer <token>'; it works only once an owner/executive approves you.",
      },
      { status: 201 },
    );
  } catch (e) {
    return badRequest((e as Error).message);
  }
}

// GET: list accounts (owner/executive only). ?status=pending to see the queue.
export async function GET(req: Request) {
  const approver = await approverFrom(req);
  if (!approver) return Response.json({ error: "forbidden" }, { status: 403 });
  const status = new URL(req.url).searchParams.get("status") ?? undefined;
  const accounts = await prisma.account.findMany({
    where: status ? { status } : {},
    orderBy: { createdAt: "desc" },
    select: { id: true, username: true, displayName: true, role: true, status: true, approvedById: true, approvedAt: true, createdAt: true },
  });
  return Response.json(accounts);
}

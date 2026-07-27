import { sessionIdentity } from "./auth";
import { resolveBearer } from "./accounts";
import { prisma } from "./db";

// Who is making this HTTP write? Returns a plain username for Item.createdBy /
// updatedBy. Order matters: a per-account session or bearer identifies a real
// person, the password session is the owner, and open local dev is "local".
// Usernames (not ids) so the record survives a rename or a deleted account.
export async function actorFor(req: Request): Promise<string> {
  const session = await sessionIdentity();
  if (session?.kind === "account") {
    const acc = await prisma.account.findUnique({
      where: { id: session.accountId },
      select: { username: true },
    });
    if (acc) return acc.username;
  }
  const bearer = await resolveBearer(req);
  if (bearer) return bearer.username;
  if (session?.kind === "password") return process.env.OWNER_USERNAME || "owner";
  return "local";
}

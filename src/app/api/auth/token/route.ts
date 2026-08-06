import { prisma } from "@/lib/db";
import { isAuthed, sessionIdentity } from "@/lib/auth";
import { getOrCreateOwner, regenerateToken } from "@/lib/accounts";
import { isDemoMode } from "@/lib/security";

// POST /api/auth/token — mint a fresh agent token for WHOEVER IS ASKING.
//
// The connect panel needs a complete, paste-and-go command, and it cannot build
// one from an existing token: tokens are stored as a SHA-256 hash, so the server
// genuinely cannot read one back. Minting is the only way to put a real token in
// front of someone, which is why this exists rather than a "show me my token"
// route — that route is impossible by design, and should stay impossible.
//
// Takes no id: it acts on the caller's own account, so nobody can mint a token
// for somebody else through it. Rotating another account's token is still an
// owner/executive action via /api/accounts/[id]/token.
export async function POST() {
  // A public read-only demo must not hand out credentials to the demo vault.
  if (isDemoMode()) {
    return Response.json({ error: "this is a read-only demo — self-host for a writable vault" }, { status: 403 });
  }

  const session = await sessionIdentity();
  let accountId: string | null = null;

  if (session?.kind === "account") {
    const acc = await prisma.account.findUnique({
      where: { id: session.accountId },
      select: { id: true, status: true },
    });
    // A pending account has no business holding a working token yet.
    if (!acc || acc.status !== "approved") {
      return Response.json({ error: "account not approved" }, { status: 403 });
    }
    accountId = acc.id;
  } else if (session?.kind === "password" || (await isAuthed())) {
    // Password login, and open local/dev mode, are both the owner at the
    // keyboard — mint against the owner account the rest of the system uses.
    accountId = (await getOrCreateOwner()).id;
  }

  if (!accountId) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { account, token } = await regenerateToken(accountId, { username: "self" });
  // Returned exactly once. The caller stores the hash, not this.
  return Response.json({ username: account.username, token });
}

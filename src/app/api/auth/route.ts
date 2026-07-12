import { cookies } from "next/headers";
import { checkPassword, makeSessionToken, authEnabled, sessionIdentity, isAuthed, SESSION_COOKIE } from "@/lib/auth";
import { resolveByToken } from "@/lib/accounts";
import { prisma } from "@/lib/db";
import { rateLimit, clientKey, tooMany } from "@/lib/ratelimit";

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: 60 * 60 * 24 * 30,
};

// POST — two ways in:
//  { password }         → workspace password (owner authority)
//  { username, token }  → per-account sign-in with the account's ovk_ bearer
//                         token (that account's authority; approval required)
export async function POST(req: Request) {
  // Credentials endpoint: brute-force protection.
  if (!rateLimit(`auth:${clientKey(req)}`, 10, 60_000)) return tooMany("too many sign-in attempts; wait a minute");
  const data = (await req.json().catch(() => ({}))) as {
    password?: unknown;
    username?: unknown;
    token?: unknown;
  };
  const store = await cookies();

  if (typeof data.username === "string" && typeof data.token === "string") {
    const acc = await resolveByToken(data.token);
    if (!acc || acc.username !== data.username.trim()) {
      return Response.json({ error: "invalid_credentials" }, { status: 401 });
    }
    if (acc.status !== "approved") {
      return Response.json({ error: "account_not_approved" }, { status: 403 });
    }
    store.set(SESSION_COOKIE, makeSessionToken(acc.id), COOKIE_OPTS);
    await prisma.auditEvent.create({ data: { action: "login", actor: acc.username, target: acc.username, detail: "web session" } });
    return Response.json({ ok: true, username: acc.username, role: acc.role });
  }

  if (!authEnabled()) return Response.json({ ok: true });
  if (typeof data.password !== "string" || !checkPassword(data.password)) {
    return Response.json({ error: "invalid_password" }, { status: 401 });
  }
  store.set(SESSION_COOKIE, makeSessionToken(), COOKIE_OPTS);
  return Response.json({ ok: true });
}

// GET — who am I? Drives the UI (identity chip, review buttons).
export async function GET() {
  const session = await sessionIdentity();
  if (session?.kind === "account") {
    const acc = await prisma.account.findUnique({
      where: { id: session.accountId },
      select: { username: true, displayName: true, role: true, status: true },
    });
    if (acc && acc.status === "approved") return Response.json({ kind: "account", ...acc });
    return Response.json({ kind: "none" }, { status: 401 });
  }
  if (session?.kind === "password") return Response.json({ kind: "owner", username: "owner", role: "owner" });
  // No cookie: open local/dev mode still counts as the owner at the keyboard.
  if (await isAuthed()) return Response.json({ kind: "open", username: "owner", role: "owner" });
  return Response.json({ kind: "none" }, { status: 401 });
}

export async function DELETE() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  return Response.json({ ok: true });
}

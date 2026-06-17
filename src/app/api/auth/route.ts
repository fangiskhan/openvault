import { cookies } from "next/headers";
import { checkPassword, makeSessionToken, authEnabled, SESSION_COOKIE } from "@/lib/auth";

export async function POST(req: Request) {
  if (!authEnabled()) return Response.json({ ok: true });

  const data = (await req.json().catch(() => ({}))) as { password?: unknown };
  if (typeof data.password !== "string" || !checkPassword(data.password)) {
    return Response.json({ error: "invalid_password" }, { status: 401 });
  }

  const store = await cookies();
  store.set(SESSION_COOKIE, makeSessionToken(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return Response.json({ ok: true });
}

export async function DELETE() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  return Response.json({ ok: true });
}

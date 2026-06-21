import { cookies } from "next/headers";
import crypto from "node:crypto";
import { secretsRequired } from "@/lib/security";

export const SESSION_COOKIE = "ov_session";

function secret(): string {
  return process.env.AUTH_SECRET || "dev-only-change-me";
}

// Auth is opt-in: a gate only exists when APP_PASSWORD is set. Local-only users
// can leave it empty; anyone exposing the server should set it.
export function authEnabled(): boolean {
  return !!(process.env.APP_PASSWORD && process.env.APP_PASSWORD.length > 0);
}

function sign(value: string): string {
  const mac = crypto.createHmac("sha256", secret()).update(value).digest("hex");
  return `${value}.${mac}`;
}

function verifyToken(token: string | undefined): boolean {
  if (!token) return false;
  const idx = token.lastIndexOf(".");
  if (idx < 0) return false;
  const expected = sign(token.slice(0, idx));
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function makeSessionToken(): string {
  return sign(`ok:${Date.now()}`);
}

export function checkPassword(pw: string): boolean {
  const expected = process.env.APP_PASSWORD || "";
  const a = Buffer.from(pw);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function isAuthed(): Promise<boolean> {
  if (!authEnabled()) {
    // No password gate configured. Open is only acceptable when running open is
    // permitted (local dev, or an explicit OPENVAULT_PUBLIC=1); a locked-down
    // production deploy fails closed instead. assertSecureBoot() should already
    // have refused to start in that case — this is the request-time backstop.
    return !secretsRequired();
  }
  const store = await cookies();
  return verifyToken(store.get(SESSION_COOKIE)?.value);
}

// For API route handlers: returns a 401 Response when blocked, else null.
export async function requireAuth(): Promise<Response | null> {
  if (await isAuthed()) return null;
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

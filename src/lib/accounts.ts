import crypto from "node:crypto";
import { prisma } from "./db";
import { isAuthed, sessionIdentity } from "./auth";

// Multi-user identity layer. Accounts are requested (pending) and must be
// approved by an owner/executive before their per-account token works. The
// owner is the root authority; owners appoint executives, who may also approve.

const USERNAME_RE = /^[a-zA-Z0-9._-]{2,40}$/;

export function newToken(): string {
  return "ovk_" + crypto.randomBytes(24).toString("hex");
}

// Tokens are stored only as SHA-256 hashes: a stolen DB/backup yields no working
// credentials. SHA-256 (not bcrypt) is right here — the input is a 192-bit
// random key, not a human password, so brute force is already infeasible and
// lookups stay a cheap indexed equality.
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// Append-only accountability record. Never updated or deleted.
async function audit(action: string, actor: string | null, target: string | null, detail?: string) {
  await prisma.auditEvent.create({ data: { action, actor, target, detail: detail ?? null } });
}

export function ownerUsername(): string {
  return process.env.OWNER_USERNAME || "owner";
}

// Root authority, created (never adopted) on first need. Adopting a pre-existing
// account named OWNER_USERNAME would be a privilege-escalation hole: anyone can
// register that username and get promoted to root owner the first time the owner
// is bootstrapped. So we only ever CREATE the owner. If the reserved name is
// already taken — a squat from before this guard existed — we mint the owner
// under a unique, un-squattable name instead of handing over the account.
export async function getOrCreateOwner() {
  const existing = await prisma.account.findFirst({ where: { role: "owner" } });
  if (existing) return existing;
  const wanted = ownerUsername();
  let username = wanted;
  if (await prisma.account.findUnique({ where: { username } })) {
    username = `${wanted}-root-${crypto.randomBytes(3).toString("hex")}`;
    await audit("bootstrap_owner_squatted", "system", wanted, `'${wanted}' was already taken; owner created as '${username}'`);
  }
  const owner = await prisma.account.create({
    data: { username, displayName: "Owner", role: "owner", status: "approved", tokenHash: hashToken(newToken()), approvedAt: new Date() },
  });
  // The bootstrap token is deliberately discarded: the owner authenticates via
  // APP_PASSWORD or MCP_TOKEN and can mint a personal token with regenerateToken.
  await audit("bootstrap_owner", "system", username);
  return owner;
}

export async function registerAccount(username: string, displayName?: string) {
  if (!USERNAME_RE.test(username)) throw new Error("invalid username (2-40 chars: letters, digits, . _ -)");
  if (username.toLowerCase() === ownerUsername().toLowerCase()) throw new Error("that username is reserved");
  if (await prisma.account.findUnique({ where: { username } })) throw new Error("username already taken");
  const token = newToken();
  const account = await prisma.account.create({
    data: { username, displayName: displayName || null, role: "member", status: "pending", tokenHash: hashToken(token) },
  });
  await audit("register", username, username, "account requested");
  // The plaintext token exists only in this return value — show it once, never again.
  return { account, token };
}

// Re-issue an account's bearer token (owner/executive action). The old token
// stops working immediately; the new plaintext is returned exactly once.
export async function regenerateToken(targetId: string, by: { username: string }) {
  const target = await prisma.account.findUnique({ where: { id: targetId } });
  if (!target) throw new Error("account not found");
  const token = newToken();
  await prisma.account.update({ where: { id: targetId }, data: { tokenHash: hashToken(token) } });
  await audit("regenerate_token", by.username, target.username);
  return { account: target, token };
}

export function resolveByToken(token: string | null | undefined) {
  if (!token) return Promise.resolve(null);
  return prisma.account.findUnique({ where: { tokenHash: hashToken(token) } });
}

// Resolve any bearer credential on a plain HTTP request: the shared MCP_TOKEN
// (constant-time compared) maps to the owner; an approved per-account token maps
// to that account. Null = no valid bearer. Lets non-MCP endpoints (e.g. the
// plain-text briefing used by session-start hooks) accept agent credentials.
export async function resolveBearer(req: Request) {
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!bearer) return null;
  const shared = process.env.MCP_TOKEN;
  if (shared) {
    const a = Buffer.from(bearer);
    const b = Buffer.from(shared);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return getOrCreateOwner();
  }
  const acc = await resolveByToken(bearer);
  return acc && acc.status === "approved" ? acc : null;
}

// The acting approver for an HTTP request: an APP_PASSWORD session counts as the
// owner; a per-account session counts as THAT account (it must itself be an
// approved owner/executive — logging in must never escalate a member to owner);
// otherwise an approved owner/executive bearer token. Null = no authority.
export async function approverFrom(req: Request) {
  const session = await sessionIdentity();
  if (session?.kind === "password") return getOrCreateOwner();
  if (session?.kind === "account") {
    const acc = await prisma.account.findUnique({ where: { id: session.accountId } });
    return acc && acc.status === "approved" && (acc.role === "owner" || acc.role === "executive") ? acc : null;
  }
  if (await isAuthed()) {
    // No cookie session, but the server runs open (dev/OPENVAULT_PUBLIC): the
    // local human is the owner, same as before accounts existed.
    return getOrCreateOwner();
  }
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const acc = await resolveByToken(bearer);
  if (acc && acc.status === "approved" && (acc.role === "owner" || acc.role === "executive")) return acc;
  return null;
}

export async function approveAccount(targetId: string, approver: { id: string; username: string }) {
  const target = await prisma.account.findUnique({ where: { id: targetId } });
  if (!target) throw new Error("account not found");
  if (target.status === "approved") return target;
  const updated = await prisma.account.update({
    where: { id: targetId },
    data: { status: "approved", approvedAt: new Date(), approvedById: approver.id },
  });
  await audit("approve", approver.username, target.username, `approved by ${approver.username}`);
  return updated;
}

export async function setRole(targetId: string, role: "executive" | "member", by: { username: string }) {
  const target = await prisma.account.findUnique({ where: { id: targetId } });
  if (!target) throw new Error("account not found");
  if (target.role === "owner") throw new Error("the owner's role cannot be changed");
  const updated = await prisma.account.update({ where: { id: targetId }, data: { role } });
  await audit("appoint_" + role, by.username, target.username);
  return updated;
}

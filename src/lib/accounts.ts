import crypto from "node:crypto";
import { prisma } from "./db";
import { isAuthed } from "./auth";

// Multi-user identity layer. Accounts are requested (pending) and must be
// approved by an owner/executive before their per-account token works. The
// owner is the root authority; owners appoint executives, who may also approve.

const USERNAME_RE = /^[a-zA-Z0-9._-]{2,40}$/;

export function newToken(): string {
  return "ovk_" + crypto.randomBytes(24).toString("hex");
}

// Append-only accountability record. Never updated or deleted.
async function audit(action: string, actor: string | null, target: string | null, detail?: string) {
  await prisma.auditEvent.create({ data: { action, actor, target, detail: detail ?? null } });
}

// Root authority. Bootstrapped on first need from OWNER_USERNAME (default "owner").
export async function getOrCreateOwner() {
  const existing = await prisma.account.findFirst({ where: { role: "owner" } });
  if (existing) return existing;
  const username = process.env.OWNER_USERNAME || "owner";
  const taken = await prisma.account.findUnique({ where: { username } });
  if (taken) {
    const up = await prisma.account.update({
      where: { id: taken.id },
      data: { role: "owner", status: "approved", approvedAt: new Date() },
    });
    await audit("bootstrap_owner", "system", username, "promoted existing account to owner");
    return up;
  }
  const owner = await prisma.account.create({
    data: { username, displayName: "Owner", role: "owner", status: "approved", token: newToken(), approvedAt: new Date() },
  });
  await audit("bootstrap_owner", "system", username);
  return owner;
}

export async function registerAccount(username: string, displayName?: string) {
  if (!USERNAME_RE.test(username)) throw new Error("invalid username (2-40 chars: letters, digits, . _ -)");
  if (await prisma.account.findUnique({ where: { username } })) throw new Error("username already taken");
  const account = await prisma.account.create({
    data: { username, displayName: displayName || null, role: "member", status: "pending", token: newToken() },
  });
  await audit("register", username, username, "account requested");
  return account;
}

export function resolveByToken(token: string | null | undefined) {
  if (!token) return Promise.resolve(null);
  return prisma.account.findUnique({ where: { token } });
}

// The acting approver for an HTTP request: an APP_PASSWORD session counts as the
// owner; otherwise an approved owner/executive bearer token. Returns null if the
// caller has no approving authority.
export async function approverFrom(req: Request) {
  if (await isAuthed()) return getOrCreateOwner();
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
  const updated = await prisma.account.update({ where: { id: targetId }, data: { role } });
  await audit("appoint_" + role, by.username, target.username);
  return updated;
}

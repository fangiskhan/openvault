import { prisma } from "./db";

// The one review implementation, used by BOTH the review_work MCP tool and the
// web UI's review route — so the gate can't drift between surfaces.
// approve → done (actor may merge/push to git); request_changes → back to
// in_progress with the reviewer's note. Audit-logged either way.
export async function reviewWorkIntent(
  intentId: string,
  verdict: "approve" | "request_changes",
  note: string | undefined,
  approver: { username: string },
) {
  if (verdict === "request_changes" && !note?.trim()) {
    throw new Error("a note is required when requesting changes");
  }
  const existing = await prisma.workIntent.findUnique({ where: { id: intentId } });
  if (!existing) throw new Error("work intent not found");
  const approved = verdict === "approve";
  const updated = await prisma.workIntent.update({
    where: { id: intentId },
    data: {
      status: approved ? "done" : "in_progress",
      reviewedBy: approved ? approver.username : null,
      reviewNote: note?.trim() || null,
      reviewedAt: new Date(),
    },
    select: { id: true, status: true, intent: true, actor: true, reviewedBy: true, reviewNote: true },
  });
  await prisma.auditEvent.create({
    data: {
      action: approved ? "approve_work" : "request_changes",
      actor: approver.username,
      target: existing.actor,
      detail: existing.intent.slice(0, 200),
    },
  });
  return {
    ...updated,
    message: approved
      ? `Approved — ${existing.actor} may merge/push these changes to git.`
      : `Changes requested — sent back to ${existing.actor} with your note.`,
  };
}

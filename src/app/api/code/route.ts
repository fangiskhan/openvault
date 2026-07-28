import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { badRequest } from "@/lib/http";

// GET /api/code?projectId=          → the project's code mirror as a tree
// GET /api/code?projectId=&path=    → one mirrored file with content
export async function GET(req: Request) {
  const denied = await requireAuth();
  if (denied) return denied;

  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId");
  const path = url.searchParams.get("path");
  if (!projectId) return badRequest("missing projectId");

  if (path) {
    // Large files span several rows; rejoin them in order.
    const rows = await prisma.codeFile.findMany({ where: { projectId, path }, orderBy: { part: "asc" } });
    if (!rows.length) return badRequest("file not in the mirror");
    const file = rows[0];
    return Response.json({
      path: file.path,
      content: rows.map((r) => r.content).join(""),
      hash: file.hash,
      size: file.size,
      parts: rows.length,
      ref: file.ref,
      syncedBy: file.syncedBy,
      updatedAt: file.updatedAt,
    });
  }

  const files = await prisma.codeFile.findMany({
    where: { projectId, part: 0 }, // one row per file, not per chunk
    orderBy: { path: "asc" },
    select: { path: true, hash: true, size: true, parts: true, ref: true, syncedBy: true, updatedAt: true },
  });
  return Response.json({ projectId, fileCount: files.length, files });
}

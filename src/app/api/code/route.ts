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
    const file = await prisma.codeFile.findUnique({ where: { projectId_path: { projectId, path } } });
    if (!file) return badRequest("file not in the mirror");
    return Response.json({
      path: file.path,
      content: file.content,
      hash: file.hash,
      ref: file.ref,
      syncedBy: file.syncedBy,
      updatedAt: file.updatedAt,
    });
  }

  const files = await prisma.codeFile.findMany({
    where: { projectId },
    orderBy: { path: "asc" },
    select: { path: true, hash: true, size: true, ref: true, syncedBy: true, updatedAt: true },
  });
  return Response.json({ projectId, fileCount: files.length, files });
}

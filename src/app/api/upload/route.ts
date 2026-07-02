import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { saveBlob, safeStorageName } from "@/lib/storage";
import { parseSpreadsheet } from "@/lib/spreadsheet";
import { syncItemLinks } from "@/lib/links";
import { badRequest } from "@/lib/http";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB

export async function POST(req: Request) {
  const denied = await requireAuth();
  if (denied) return denied;

  // Reject oversized bodies before buffering them into memory.
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared && declared > MAX_UPLOAD_BYTES) return badRequest("file too large (max 25 MB)");

  const form = await req.formData().catch(() => null);
  if (!form) return badRequest("expected multipart form data");

  const file = form.get("file");
  const projectId = String(form.get("projectId") || "");
  if (!(file instanceof File)) return badRequest("missing file");
  if (!projectId) return badRequest("missing projectId");

  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
  if (!project) return badRequest("unknown projectId");

  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length > MAX_UPLOAD_BYTES) return badRequest("file too large (max 25 MB)");
  const isSheet = /\.(xlsx|xlsm|csv)$/i.test(file.name);
  const storageKey = `${projectId}/${Date.now()}-${safeStorageName(file.name)}`;
  await saveBlob(storageKey, buf, file.type || "application/octet-stream");

  let type = "file";
  let body = `Uploaded file **${file.name}**.`;
  let metadata: string | null = null;

  if (isSheet) {
    type = "spreadsheet";
    const sheets = await parseSpreadsheet(file.name, buf);
    metadata = JSON.stringify({ sheets });
    body = `Spreadsheet **${file.name}** — ${sheets.length} sheet(s): ${sheets.map((s) => s.name).join(", ")}.`;
  }

  const item = await prisma.item.create({
    data: { projectId, type, source: "upload", title: file.name, body, metadata },
  });
  await prisma.fileAsset.create({
    data: {
      projectId,
      itemId: item.id,
      filename: file.name,
      mimeType: file.type || "",
      size: buf.length,
      storageKey,
    },
  });
  await syncItemLinks(item.id, projectId, body);

  return Response.json(item, { status: 201 });
}

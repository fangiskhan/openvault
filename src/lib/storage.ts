import { promises as fs } from "node:fs";
import path from "node:path";
import { prisma } from "./db";

// Blob storage adapter. Three drivers:
//   local   — disk under ./storage. The default when a disk is writable.
//   db      — bytes in the FileAsset row. The default on a serverless host,
//             whose filesystem is read-only, so uploads there used to fail
//             with an unexplained 500 unless a blob store was set up first.
//   vercel  — Vercel Blob, for deployments that outgrow the db cap.
const ROOT = path.resolve(process.cwd(), "storage");

// Above this a file belongs in object storage, not a row. Also comfortably
// above Vercel's own 4.5 MB request-body cap, so on that platform the limit
// that bites first is theirs, not ours.
export const DB_BLOB_MAX_BYTES = Number(process.env.DB_BLOB_MAX_BYTES ?? 8 * 1024 * 1024);

export type StorageDriver = "local" | "db" | "vercel";

// Explicit setting wins; otherwise pick what can actually work here. A
// serverless filesystem is read-only, so defaulting to local disk there is
// choosing a driver that is guaranteed to fail.
export function storageDriver(): StorageDriver {
  const set = process.env.STORAGE_DRIVER;
  if (set === "vercel" || set === "db" || set === "local") return set;
  return process.env.VERCEL ? "db" : "local";
}

// Strip any directory components an attacker might smuggle in a filename
// (`../`, absolute paths, either separator) and keep only safe characters, so
// a storage key built from user input can never traverse out of its folder.
export function safeStorageName(name: string): string {
  const base = name.split(/[/\\]/).pop() || "file";
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
  return cleaned || "file";
}

// Resolve a key under ROOT and refuse anything that escapes it (`..`, absolute
// paths, symlinked separators). Callers sanitize filenames too; this is the
// last line of defense so a crafted key can never write outside storage/.
export function resolveUnderRoot(key: string): string {
  const full = path.resolve(ROOT, key);
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) {
    throw new Error("invalid storage key");
  }
  return full;
}

export async function saveBlob(key: string, data: Buffer, contentType: string): Promise<void> {
  const driver = storageDriver();
  if (driver === "db") {
    // Written by the caller alongside the FileAsset row it belongs to; there
    // is nothing to do here but validate, because the row IS the storage.
    if (data.length > DB_BLOB_MAX_BYTES) {
      throw new Error(
        `file is ${(data.length / 1024 / 1024).toFixed(1)} MB; this deployment stores files in the database up to ${(
          DB_BLOB_MAX_BYTES /
          1024 /
          1024
        ).toFixed(1)} MB. Configure STORAGE_DRIVER=vercel with a Blob store for larger files.`,
      );
    }
    return;
  }
  if (driver === "vercel") {
    // Requires `npm i @vercel/blob` and BLOB_READ_WRITE_TOKEN in the env.
    const { put } = await import("@vercel/blob").catch(() => {
      throw new Error("STORAGE_DRIVER=vercel requires the @vercel/blob package");
    });
    await put(key, data, {
      access: "public",
      contentType,
      token: process.env.BLOB_READ_WRITE_TOKEN,
      addRandomSuffix: false,
    });
    return;
  }
  const full = resolveUnderRoot(key);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, data);
}

export async function readBlob(key: string): Promise<Buffer> {
  // Must mirror saveBlob's driver split. It did not: reads always hit local
  // disk, so every file stored in Vercel Blob was write-only — uploadable in
  // production and impossible to get back.
  const driver = storageDriver();
  if (driver === "db") {
    const row = await prisma.fileAsset.findFirst({ where: { storageKey: key }, select: { data: true } });
    if (!row?.data) throw new Error(`no stored bytes for ${key}`);
    return Buffer.from(row.data);
  }
  if (driver === "vercel") {
    const { head } = await import("@vercel/blob").catch(() => {
      throw new Error("STORAGE_DRIVER=vercel requires the @vercel/blob package");
    });
    const meta = await head(key, { token: process.env.BLOB_READ_WRITE_TOKEN });
    const res = await fetch(meta.url);
    if (!res.ok) throw new Error(`blob fetch failed: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  return fs.readFile(resolveUnderRoot(key));
}

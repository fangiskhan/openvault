import { promises as fs } from "node:fs";
import path from "node:path";

// Blob storage adapter. Local disk for self-host/your-own-PC; Vercel Blob for
// the cloud (Vercel has no persistent disk). Returns a stable storageKey.
const ROOT = path.resolve(process.cwd(), "storage");

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
  if (process.env.STORAGE_DRIVER === "vercel") {
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
  return fs.readFile(resolveUnderRoot(key));
}

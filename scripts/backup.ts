import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { prisma } from "../src/lib/db";

// npm run db:backup — full-vault JSON snapshot (same openvault-export/v1 format
// as GET /api/export) written to ./backups/, straight from the DB so it works
// with the server stopped. Schedule it with Task Scheduler / cron for automatic
// backups; restore = the importer or any JSON tooling. Your data stays yours.
async function main() {
  const projects = await prisma.project.findMany({
    include: { items: { orderBy: { createdAt: "asc" } } },
  });
  const relations = await prisma.projectRelation.findMany();
  const accounts = await prisma.account.findMany({
    select: { username: true, displayName: true, role: true, status: true, createdAt: true }, // no token hashes
  });
  const skills = await prisma.projectSkill.findMany({
    select: { projectId: true, name: true, description: true, body: true, updatedAt: true },
  });
  // The mirror IS backed up now. It used to be counted and skipped, on the
  // assumption it could always be re-synced from a checkout — which is false
  // for work authored through the mirror itself, and that assumption cost a
  // real day's CSS that existed nowhere else.
  const codeRows = await prisma.codeFile.findMany({ orderBy: [{ path: "asc" }, { part: "asc" }] });
  const byPath = new Map<string, { projectId: string; path: string; hash: string; size: number; ref: string | null; syncedBy: string | null; content: string }>();
  for (const r of codeRows) {
    const key = `${r.projectId}|${r.path}`;
    const seen = byPath.get(key);
    if (seen) seen.content += r.content; // rejoin chunked files
    else byPath.set(key, { projectId: r.projectId, path: r.path, hash: r.hash, size: r.size, ref: r.ref, syncedBy: r.syncedBy, content: r.content });
  }
  const codeFiles = [...byPath.values()];

  const payload = {
    format: "openvault-export/v2",
    exportedAt: new Date().toISOString(),
    projectCount: projects.length,
    projects,
    relations,
    accounts,
    skills,
    codeFiles,
  };

  const dir = path.join(process.cwd(), "backups");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `openvault-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify(payload, null, 2));
  console.log(`Backed up ${projects.length} project(s) → ${path.relative(process.cwd(), file)}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    prisma.$disconnect();
    process.exit(1);
  });

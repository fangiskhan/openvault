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
  const codeFiles = await prisma.codeFile.count();

  const payload = {
    format: "openvault-export/v1",
    exportedAt: new Date().toISOString(),
    projectCount: projects.length,
    projects,
    relations,
    accounts,
    note: codeFiles > 0 ? `${codeFiles} code-mirror files not included (re-sync from agents)` : undefined,
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

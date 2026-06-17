import { prisma } from "../src/lib/db";
import { syncItemLinks, resolveGhostLinks } from "../src/lib/links";
import { slugify } from "../src/lib/slug";

async function main() {
  // Dev convenience: reset so re-seeding is idempotent.
  await prisma.link.deleteMany();
  await prisma.itemTag.deleteMany();
  await prisma.fileAsset.deleteMany();
  await prisma.item.deleteMany();
  await prisma.projectRelation.deleteMany();
  await prisma.project.deleteMany();

  const atlas = await prisma.project.create({
    data: { name: "Project Atlas", slug: slugify("Project Atlas"), description: "Client engagement — platform rebuild.", color: "#8b7cf6" },
  });
  const orion = await prisma.project.create({
    data: { name: "Project Orion", slug: slugify("Project Orion"), description: "Follow-on data migration.", color: "#5fb3a1" },
  });
  const nova = await prisma.project.create({
    data: { name: "Project Nova", slug: slugify("Project Nova"), description: "Unrelated R&D.", color: "#d08770" },
  });

  // Connect Atlas <-> Orion (sorted pair). Nova stays isolated.
  const [a, b] = [atlas.id, orion.id].sort();
  await prisma.projectRelation.create({ data: { fromProjectId: a, toProjectId: b, kind: "related" } });

  const notes: Array<[string, string, string]> = [
    [atlas.id, "Welcome", "# Welcome to OpenVault\n\nA self-hosted, project-centric workspace. Notes, meetings, tasks, and spreadsheets all live inside a **project**.\n\nStart with the [[Kickoff Meeting]] or the [[Architecture Decisions]].\n\nProjects can be **connected**: [[Orion Data Model]] lives in Project Orion but its link resolves here because Atlas and Orion are connected.\n\n#welcome"],
    [atlas.id, "Kickoff Meeting", "# Kickoff Meeting\n\n- Attendees: PM, Lead, Client\n- Goal: scope the rebuild\n\nActions captured in [[Tasks]]; design choices in [[Architecture Decisions]].\n\n> Decision: ship an MVP in 6 weeks."],
    [atlas.id, "Architecture Decisions", "# Architecture Decisions\n\n1. Next.js + Postgres\n2. Self-hosted for the client's security requirements\n\nMigration work is tracked in [[Orion Data Model]] over in Project Orion."],
    [atlas.id, "Tasks", "# Tasks\n\n- [ ] Finalize scope\n- [ ] Set up the repo\n- [ ] Draft the data model — see [[Architecture Decisions]]"],
    [orion.id, "Orion Data Model", "# Orion Data Model\n\nThe migration schema. Feeds back into [[Architecture Decisions]] in Project Atlas.\n\n- accounts\n- transactions\n- ledgers"],
    [orion.id, "Migration Plan", "# Migration Plan\n\nPhased cutover, depends on [[Orion Data Model]]."],
    [nova.id, "Research Notes", "# Research Notes\n\nIsolated R&D. Nothing here links to Atlas or Orion — and search scoped to this project won't reach them."],
  ];

  for (const [projectId, title, body] of notes) {
    await prisma.item.create({ data: { projectId, title, body, type: title === "Kickoff Meeting" ? "meeting" : title === "Tasks" ? "task" : "note" } });
  }

  // Live status signals so the Status view + MCP demonstrate "red" out of the box.
  const tasksItem = await prisma.item.findFirst({ where: { projectId: atlas.id, type: "task" } });
  if (tasksItem) {
    await prisma.item.update({
      where: { id: tasksItem.id },
      data: { status: "blocked", dueAt: new Date(Date.now() - 4 * 86_400_000) },
    });
  }
  await prisma.item.create({
    data: {
      projectId: atlas.id,
      type: "risk",
      status: "open",
      title: "Vendor API may slip",
      body: "Third-party API delivery is slipping. Mitigation: build a stub. Evidence: [[Kickoff Meeting]].",
    },
  });

  const all = await prisma.item.findMany();
  for (const it of all) await syncItemLinks(it.id, it.projectId, it.body);
  for (const it of all) await resolveGhostLinks(it.id, it.projectId, it.title);

  console.log(`Seeded ${all.length} notes across 3 projects (Atlas <-> Orion connected, Nova isolated).`);
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    prisma.$disconnect();
    process.exit(1);
  });

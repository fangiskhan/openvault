import { prisma } from "../db";
import { slugify, uniqueSlug } from "../slug";
import { syncItemLinks, resolveGhostLinks } from "../links";

export type ImportNote = { title: string; body: string; type?: string };

export type ImportInput = {
  projectName: string;
  color?: string;
  description?: string;
  notes: ImportNote[];
  mocTitle?: string; // create a Map-of-Content note that wikilinks every imported note
  connectTo?: string[]; // project names or ids to connect to
  replace?: boolean; // wipe the project's existing items first
};

// Create Obsidian-style linked notes from content: one note per entry, an
// optional MOC index that wikilinks them, project connections, and full link
// resolution so backlinks and the graph light up.
export async function importProject(input: ImportInput) {
  let project = await prisma.project.findFirst({ where: { name: input.projectName } });

  if (!project) {
    const existing = await prisma.project.findMany({ select: { slug: true } });
    const slug = uniqueSlug(slugify(input.projectName), new Set(existing.map((e) => e.slug)));
    project = await prisma.project.create({
      data: { name: input.projectName, slug, color: input.color ?? "#8b7cf6", description: input.description },
    });
  } else if (input.replace) {
    await prisma.item.deleteMany({ where: { projectId: project.id } });
  }

  const created: { id: string; body: string }[] = [];
  for (const n of input.notes) {
    const item = await prisma.item.create({
      data: { projectId: project.id, title: n.title, body: n.body, type: n.type ?? "note", source: "import" },
    });
    created.push({ id: item.id, body: item.body });
  }

  if (input.mocTitle && created.length) {
    const body = `# ${input.mocTitle}\n\n` + input.notes.map((n) => `- [[${n.title}]]`).join("\n");
    const moc = await prisma.item.create({
      data: { projectId: project.id, title: input.mocTitle, body, type: "note", source: "import" },
    });
    created.push({ id: moc.id, body: moc.body });
  }

  if (input.connectTo?.length) {
    const others = await prisma.project.findMany({
      where: { OR: [...input.connectTo.map((c) => ({ name: c })), ...input.connectTo.map((c) => ({ id: c }))] },
      select: { id: true },
    });
    for (const o of others) {
      if (o.id === project.id) continue;
      const [a, b] = [project.id, o.id].sort();
      await prisma.projectRelation.upsert({
        where: { fromProjectId_toProjectId: { fromProjectId: a, toProjectId: b } },
        create: { fromProjectId: a, toProjectId: b, kind: "related" },
        update: {},
      });
    }
  }

  // Resolve [[wikilinks]] → real edges + backlinks (the MOC links every note).
  for (const it of created) await syncItemLinks(it.id, project.id, it.body);
  for (const it of created) await resolveGhostLinks(it.id, project.id, project.name);

  return { projectId: project.id, slug: project.slug, noteCount: created.length };
}

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
const STOPWORDS = new Set(
  "the and for that with you your this have from will into are was were our out get got can not but they them then than what when where which while over under just only also more some need want make like there their here this that note notes session".split(
    " ",
  ),
);

function keywordsOf(text: string): Set<string> {
  const counts = new Map<string, number>();
  for (const w of text.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? []) {
    if (STOPWORDS.has(w)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return new Set(
    [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map((e) => e[0]),
  );
}

// Obsidian-style cross-linking: append a "## Related" section of [[wikilinks]]
// to each note, pointing at the few notes it shares the most keywords with — so
// the graph becomes a web, not a star. Cheap, deterministic, no AI.
function withRelatedLinks(notes: ImportNote[], maxLinks = 3, minShared = 2): ImportNote[] {
  if (notes.length < 3) return notes;
  const kw = notes.map((n) => keywordsOf(`${n.title} ${n.body}`));
  return notes.map((n, i) => {
    const related = notes
      .map((m, j) => ({ title: m.title, shared: j === i ? -1 : [...kw[i]].filter((w) => kw[j].has(w)).length }))
      .filter((x) => x.shared >= minShared)
      .sort((a, b) => b.shared - a.shared)
      .slice(0, maxLinks)
      .map((x) => x.title);
    if (!related.length) return n;
    return { ...n, body: `${n.body}\n\n## Related\n${related.map((t) => `- [[${t}]]`).join("\n")}` };
  });
}

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

  const notes = withRelatedLinks(input.notes);

  const created: { id: string; body: string }[] = [];
  for (const n of notes) {
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

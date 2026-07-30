import { prisma } from "../db";
import { slugify, uniqueSlug } from "../slug";
import { syncItemLinks, resolveGhostLinks } from "../links";
import { connectedProjectIds } from "../projects";
import { buildCorpus, cosine } from "../related";
import { CONTENT_TYPES } from "../validation";

export type ImportNote = { title: string; body: string; type?: string };

export type ImportInput = {
  projectName: string;
  color?: string;
  description?: string;
  notes: ImportNote[];
  mocTitle?: string; // create a Map-of-Content note that wikilinks every imported note
  connectTo?: string[]; // project names or ids to connect to
  replace?: boolean; // wipe the project's existing items first
  actor?: string; // who is importing — stamped on every created note
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
// to each note. Two sources, one block:
//   1. Other notes in the same batch, by shared keywords — so an import becomes
//      a web rather than a star.
//   2. Notes ALREADY in this project or a connected one, by TF-IDF similarity —
//      so the import joins the graph that exists instead of landing as an
//      island. Without this, a new note can only reach an existing topic hub if
//      the agent happened to guess and type the right [[wikilink]].
// Both are deterministic and cost no model calls.
export function withRelatedLinks(
  notes: ImportNote[],
  existing: Array<{ title: string; body: string }> = [],
  { maxInBatch = 3, minShared = 2, maxExisting = 2, minScore = 0.12 } = {},
): ImportNote[] {
  const kw = notes.map((n) => keywordsOf(`${n.title} ${n.body}`));
  const incomingTitles = new Set(notes.map((n) => n.title.toLowerCase()));
  const simText = (t: string, b: string) => `${t}\n${t}\n${b.slice(0, 5000)}`;
  // One corpus over incoming + existing, so an imported note can find the hub
  // note that already covers its topic.
  const corpus = existing.length
    ? buildCorpus([
        ...notes.map((n, i) => ({ id: `new:${i}`, projectId: "new", text: simText(n.title, n.body) })),
        ...existing.map((e, j) => ({ id: `old:${j}`, projectId: "old", text: simText(e.title, e.body) })),
      ])
    : null;

  return notes.map((n, i) => {
    const inBatch =
      notes.length < 3
        ? []
        : notes
            .map((m, j) => ({ title: m.title, shared: j === i ? -1 : [...kw[i]].filter((w) => kw[j].has(w)).length }))
            .filter((x) => x.shared >= minShared)
            .sort((a, b) => b.shared - a.shared)
            .slice(0, maxInBatch)
            .map((x) => x.title);

    const fromVault = corpus
      ? existing
          .map((e, j) => ({
            title: e.title,
            score: cosine(corpus.vectors.get(`new:${i}`)!, corpus.vectors.get(`old:${j}`)!),
          }))
          // A title also present in this batch is handled by the in-batch pass.
          .filter((x) => x.score >= minScore && !incomingTitles.has(x.title.toLowerCase()))
          .sort((a, b) => b.score - a.score)
          .slice(0, maxExisting)
          .map((x) => x.title)
      : [];

    const related = [...new Set([...inBatch, ...fromVault])];
    // Strip any pre-existing "## Related" block(s) first, so re-ingesting a note
    // never stacks duplicate Related sections, then append the fresh one.
    const base = n.body.replace(/\n*##\s*Related\s*\n(?:[ \t]*-[^\n]*\n?)*/gi, "").trimEnd();
    if (!related.length) return base === n.body ? n : { ...n, body: base };
    return { ...n, body: `${base}\n\n## Related\n${related.map((t) => `- [[${t}]]`).join("\n")}` };
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

  // The graph this import should join: notes already in this project or a
  // connected one. Projects named in connectTo count too — those relations are
  // created below, before links are resolved, so links into them will land.
  const connectTargets = input.connectTo?.length
    ? (
        await prisma.project.findMany({
          where: { OR: [...input.connectTo.map((c) => ({ name: c })), ...input.connectTo.map((c) => ({ id: c }))] },
          select: { id: true },
        })
      ).map((p) => p.id)
    : [];
  const scopeIds = [...new Set([...(await connectedProjectIds(project.id)), ...connectTargets])];
  const existingNotes = await prisma.item.findMany({
    where: { projectId: { in: scopeIds }, type: { in: [...CONTENT_TYPES] } },
    select: { title: true, body: true },
    orderBy: { updatedAt: "desc" },
    take: 600,
  });

  const notes = withRelatedLinks(input.notes, existingNotes);

  const by = input.actor || "import";
  // Idempotent by title: re-importing a note UPDATES the existing item instead
  // of filing a duplicate. import_notes used to create unconditionally, so a
  // re-run — the normal case for "update the vault's copy of X" — left two
  // items with identical titles competing in search, with wikilink resolution
  // picking one arbitrarily. Case-insensitive, matching how wikilinks resolve.
  // One titles fetch up front, kept current as the batch lands, so a batch that
  // repeats a title (or a re-imported MOC) also folds onto itself.
  const titleToId = new Map<string, string>(
    (await prisma.item.findMany({ where: { projectId: project.id }, select: { id: true, title: true } })).map((r) => [
      r.title.toLowerCase(),
      r.id,
    ]),
  );
  const upsertByTitle = async (title: string, body: string, type: string) => {
    const existingId = titleToId.get(title.toLowerCase());
    if (existingId) {
      const item = await prisma.item.update({
        where: { id: existingId },
        data: { body, type, updatedBy: by },
        select: { id: true, body: true },
      });
      return { item, updated: true };
    }
    const item = await prisma.item.create({
      data: { projectId: project!.id, title, body, type, source: "import", createdBy: by, updatedBy: by },
      select: { id: true, body: true },
    });
    titleToId.set(title.toLowerCase(), item.id);
    return { item, updated: false };
  };

  const created: { id: string; body: string }[] = [];
  let updatedCount = 0;
  for (const n of notes) {
    const { item, updated } = await upsertByTitle(n.title, n.body, n.type ?? "note");
    if (updated) updatedCount++;
    created.push({ id: item.id, body: item.body });
  }

  if (input.mocTitle && created.length) {
    const body = `# ${input.mocTitle}\n\n` + input.notes.map((n) => `- [[${n.title}]]`).join("\n");
    const { item: moc, updated } = await upsertByTitle(input.mocTitle, body, "note");
    if (updated) updatedCount++;
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

  return { projectId: project.id, slug: project.slug, noteCount: created.length, updated: updatedCount };
}

import { prisma } from "./db";
import { CONTENT_TYPES } from "./validation";
import { embed, embeddingsEnabled, parseVector, cosineVec } from "./embeddings";

// Ranked search shared by the search MCP tool and GET /api/search.
//
// Substring matching alone fails the way agents actually ask: "why no
// server-side AI" matches nothing, because no note contains that exact string.
// So a multi-word query is tokenized and scored by how many of its terms a note
// carries (title hits weigh more than body hits, an exact phrase hit wins
// outright). Quoted queries stay literal for when you know what you want.

const STOPWORDS = new Set(
  "the a an and or of to in on for with is are was were be been it its this that these those as at by from we you i our your their they them he she do does did not no if then than so but about into over under up out also just only more most some any all each what when where which who how why can could should would will have has had need want make like there here".split(
    " ",
  ),
);

export type SearchHit = {
  id: string;
  title: string;
  type: string;
  status: string | null;
  body: string;
  projectId: string;
  project: { name: string; color: string | null };
  updatedAt: Date;
  score: number;
  /** Present when the semantic layer contributed: 0..1 cosine similarity. */
  semantic?: number;
};

export function queryTerms(query: string): string[] {
  const terms = new Set<string>();
  const add = (t: string) => {
    if (t.length >= 2 && !STOPWORDS.has(t)) terms.add(t);
  };
  for (const raw of query.toLowerCase().split(/[^a-z0-9_+#.-]+/)) {
    const t = raw.replace(/^[.-]+|[.-]+$/g, "");
    add(t);
    // Compounds match either spelling: "server-side" also probes "server" and
    // "side", so a note written "server side" still surfaces (and vice versa).
    if (/[.-]/.test(t)) for (const part of t.split(/[.-]/)) add(part);
  }
  return [...terms];
}

export async function searchItems(
  query: string,
  projectIds: string[] | null,
  limit = 20,
): Promise<SearchHit[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  // "quoted" → literal phrase only.
  const quoted = /^".+"$/.test(trimmed);
  const phrase = quoted ? trimmed.slice(1, -1) : trimmed;
  const terms = quoted ? [] : queryTerms(trimmed);

  const where = {
    type: { in: [...CONTENT_TYPES] },
    ...(projectIds ? { projectId: { in: projectIds } } : {}),
    OR:
      terms.length > 0
        ? terms.flatMap((t) => [{ title: { contains: t } }, { body: { contains: t } }])
        : [{ title: { contains: phrase } }, { body: { contains: phrase } }],
  };

  const rows = await prisma.item.findMany({
    where,
    // Cap the candidate set before scoring so a common term can't pull the vault.
    take: Math.max(limit * 10, 100),
    orderBy: { updatedAt: "desc" },
    select: {
      id: true, title: true, type: true, status: true, body: true,
      projectId: true, updatedAt: true,
      project: { select: { name: true, color: true } },
    },
  });

  const phraseLower = phrase.toLowerCase();
  const lexical = new Map<string, number>();
  for (const r of rows) {
    const title = r.title.toLowerCase();
    const body = r.body.toLowerCase();
    let matched = 0;
    let weighted = 0;
    for (const t of terms) {
      const inTitle = title.includes(t);
      const inBody = body.includes(t);
      if (inTitle || inBody) matched++;
      if (inTitle) weighted += 3;
      if (inBody) weighted += 1;
    }
    // Coverage dominates: a note answering five of six words of the question
    // beats one that merely repeats a single word in its title.
    let score = matched * 10 + weighted;
    // A note carrying the whole phrase beats one that merely shares words.
    if (title.includes(phraseLower)) score += 40;
    else if (body.includes(phraseLower)) score += 20;
    if (score > 0) lexical.set(r.id, score);
  }

  type Row = (typeof rows)[number];
  const byId = new Map<string, Row>(rows.map((r) => [r.id, r]));
  const semantic = new Map<string, number>();

  // The semantic pass needs its OWN candidate pool. Re-ranking the lexical
  // results would be pointless: a note that shares no words with the question
  // never reaches the ranker, and those are exactly the ones this is for.
  if (embeddingsEnabled()) {
    try {
      const [qv] = (await embed([trimmed])) ?? [];
      if (qv) {
        const pool = await prisma.item.findMany({
          where: {
            type: { in: [...CONTENT_TYPES] },
            ...(projectIds ? { projectId: { in: projectIds } } : {}),
            embedding: { not: null },
          },
          orderBy: { updatedAt: "desc" },
          take: 2000,
          select: {
            id: true, title: true, type: true, status: true, body: true,
            projectId: true, updatedAt: true, embedding: true,
            project: { select: { name: true, color: true } },
          },
        });
        for (const p of pool) {
          const v = parseVector(p.embedding);
          if (!v) continue;
          const sim = cosineVec(qv, v);
          if (sim < 0.25) continue; // below this it is noise, not relatedness
          semantic.set(p.id, sim);
          if (!byId.has(p.id)) {
            // Drop the vector before it joins the result rows — callers get
            // notes, not a few KB of floats per hit.
            const rest: Row = {
              id: p.id, title: p.title, type: p.type, status: p.status, body: p.body,
              projectId: p.projectId, updatedAt: p.updatedAt, project: p.project,
            };
            byId.set(p.id, rest);
          }
        }
      }
    } catch {
      // An embedding endpoint that is down must never take search down with it.
    }
  }

  // Blend on a common scale: lexical normalized against the best lexical hit,
  // cosine already 0..1. Lexical leads because exact wording is a strong signal
  // when it exists; semantic carries the notes that share meaning but no words.
  const maxLex = Math.max(1, ...lexical.values());
  const out: SearchHit[] = [];
  for (const [id, row] of byId) {
    const lex = (lexical.get(id) ?? 0) / maxLex;
    const sem = semantic.get(id) ?? 0;
    if (lex === 0 && sem === 0) continue;
    out.push({
      ...row,
      score: Math.round((lex * 0.6 + sem * 0.4) * 1000) / 1000,
      ...(sem ? { semantic: Math.round(sem * 100) / 100 } : {}),
    });
  }

  return out
    .sort((a, b) => b.score - a.score || b.updatedAt.getTime() - a.updatedAt.getTime())
    .slice(0, limit);
}

// Show the matched region, not just the head of the note.
export function snippet(body: string, query: string, width = 140): string {
  const lower = body.toLowerCase();
  const candidates = [query.trim().toLowerCase().replace(/^"|"$/g, ""), ...queryTerms(query)];
  let idx = -1;
  for (const c of candidates) {
    if (!c) continue;
    idx = lower.indexOf(c);
    if (idx >= 0) break;
  }
  if (idx < 0) return body.slice(0, width).replace(/\s+/g, " ");
  const start = Math.max(0, idx - 50);
  return (start > 0 ? "…" : "") + body.slice(start, start + width).replace(/\s+/g, " ");
}

// Inferred knowledge connections (Graphify-inspired, TS-native): TF-IDF cosine
// similarity over note text finds notes that BELONG together but were never
// wikilinked, and project pairs that share concepts before anyone connects
// them. Deterministic, dependency-free, fine at vault scale (thousands of
// notes). Explicit wikilinks stay the ground truth; these are suggestions,
// always served with the shared terms that explain them ("every edge explained").

const STOPWORDS = new Set(
  ("the a an and or of to in on for with is are was were be been being it its this that these those as at by from we you i our your their they he she will would can could should shall has have had do does did not no nor if then than so but about into over under up out also just more most some any all each other when what which who whom how why where there here s t d ll m re ve don didn isn aren won").split(" "),
);

export function tokenize(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (raw.length < 3 || raw.length > 40 || STOPWORDS.has(raw) || /^\d+$/.test(raw)) continue;
    counts.set(raw, (counts.get(raw) ?? 0) + 1);
  }
  return counts;
}

export type Doc = { id: string; projectId: string; text: string };
export type Corpus = { vectors: Map<string, Map<string, number>>; docs: Doc[] };

// TF-IDF weighted, L2-normalized vectors for the whole corpus.
export function buildCorpus(docs: Doc[]): Corpus {
  const termCounts = docs.map((d) => tokenize(d.text));
  const df = new Map<string, number>();
  for (const counts of termCounts) {
    for (const term of counts.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const n = docs.length || 1;
  const vectors = new Map<string, Map<string, number>>();
  docs.forEach((d, i) => {
    const vec = new Map<string, number>();
    let norm = 0;
    for (const [term, tf] of termCounts[i]) {
      const w = tf * Math.log(1 + n / (df.get(term) ?? 1));
      vec.set(term, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [term, w] of vec) vec.set(term, w / norm);
    vectors.set(d.id, vec);
  });
  return { vectors, docs };
}

export function cosine(a: Map<string, number>, b: Map<string, number>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [term, w] of small) {
    const v = large.get(term);
    if (v) dot += w * v;
  }
  return dot;
}

// The terms that carry a pair's similarity — the human-readable "why".
export function sharedTerms(a: Map<string, number>, b: Map<string, number>, top = 5): string[] {
  const scored: Array<[string, number]> = [];
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const [term, w] of small) {
    const v = large.get(term);
    if (v) scored.push([term, w * v]);
  }
  return scored.sort((x, y) => y[1] - x[1]).slice(0, top).map(([t]) => t);
}

// Deterministic label propagation: cheap community detection good enough to
// name a vault's topic clusters. Nodes ordered stably; ties break to the
// smallest label; few fixed rounds so it always terminates identically.
export function detectCommunities(nodeIds: string[], edges: Array<{ from: string; to: string }>): Map<string, string> {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e.to);
    (adj.get(e.to) ?? adj.set(e.to, []).get(e.to)!).push(e.from);
  }
  const label = new Map<string, string>(nodeIds.map((id) => [id, id]));
  const order = [...nodeIds].sort();
  for (let round = 0; round < 8; round++) {
    let changed = false;
    for (const node of order) {
      const neighbors = adj.get(node);
      if (!neighbors?.length) continue;
      const freq = new Map<string, number>();
      for (const nb of neighbors) {
        const l = label.get(nb)!;
        freq.set(l, (freq.get(l) ?? 0) + 1);
      }
      let best = label.get(node)!;
      let bestCount = 0;
      for (const [l, c] of [...freq.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        if (c > bestCount) {
          best = l;
          bestCount = c;
        }
      }
      if (best !== label.get(node)) {
        label.set(node, best);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return label;
}

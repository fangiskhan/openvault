import crypto from "node:crypto";

// Optional semantic layer. Lexical search cannot tell "about the same thing"
// from "shares rare words" — that limit produced two real misses in this
// codebase's own history (a natural-language query returning nothing, and
// bridge detection reading shared tooling as shared subject). Embeddings fix
// both, but hosting a model would break the rule that the server runs no
// inference, so this is OPT-IN and points at whatever endpoint you already
// have: OpenAI, or a local Ollama / LM Studio for free and private.
//
//   EMBEDDING_URL   OpenAI-compatible embeddings endpoint
//                   e.g. https://api.openai.com/v1/embeddings
//                   or   http://localhost:11434/v1/embeddings   (Ollama)
//   EMBEDDING_MODEL e.g. text-embedding-3-small | nomic-embed-text
//   EMBEDDING_KEY   omit for a local endpoint that needs no auth
//
// Unconfigured, everything below no-ops and search stays purely lexical.

export function embeddingConfig() {
  const url = process.env.EMBEDDING_URL?.trim();
  const model = process.env.EMBEDDING_MODEL?.trim();
  return url && model ? { url, model, key: process.env.EMBEDDING_KEY?.trim() } : null;
}

export const embeddingsEnabled = () => embeddingConfig() !== null;

// Vectors are stored as JSON text, not a pgvector column: it keeps one schema
// working on both SQLite and Postgres (a standing constraint here), and at
// vault scale — thousands of notes — scoring in JS is milliseconds.
export function serializeVector(v: number[]): string {
  return JSON.stringify(v.map((x) => Math.round(x * 1e6) / 1e6));
}

export function parseVector(s: string | null): number[] | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) && v.length ? (v as number[]) : null;
  } catch {
    return null;
  }
}

// Marks which text a stored vector was built from, so a re-embed only touches
// notes that actually changed.
export function embedHash(title: string, body: string): string {
  return crypto.createHash("sha256").update(`${title}\n${body}`).digest("hex").slice(0, 32);
}

export function embedText(title: string, body: string): string {
  return `${title}\n\n${body.slice(0, 8000)}`;
}

export function cosineVec(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// Batched so a backfill of a whole vault is a handful of requests. Returns null
// when embeddings are not configured, so every caller degrades to lexical.
export async function embed(texts: string[]): Promise<number[][] | null> {
  const cfg = embeddingConfig();
  if (!cfg || texts.length === 0) return null;

  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 64) {
    const batch = texts.slice(i, i + 64);
    const res = await fetch(cfg.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cfg.key ? { authorization: `Bearer ${cfg.key}` } : {}),
      },
      body: JSON.stringify({ model: cfg.model, input: batch }),
    });
    if (!res.ok) throw new Error(`embedding endpoint returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { data?: Array<{ embedding: number[] }> };
    if (!json.data?.length) throw new Error("embedding endpoint returned no data");
    out.push(...json.data.map((d) => d.embedding));
  }
  return out;
}

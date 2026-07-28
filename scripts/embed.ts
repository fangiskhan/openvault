import { prisma } from "../src/lib/db";
import { embed, embeddingsEnabled, embedHash, embedText, serializeVector } from "../src/lib/embeddings";
import { CONTENT_TYPES } from "../src/lib/validation";

// npm run embed — build/refresh the optional semantic index.
//
// Only notes whose text changed since their last embedding are sent, so a
// re-run after a day's work costs a handful of vectors, not the whole vault.
// Safe to schedule (Task Scheduler / cron) alongside npm run db:backup.
async function main() {
  if (!embeddingsEnabled()) {
    console.log(
      "Embeddings are not configured, so search stays lexical (which is a fine default).\n" +
        "To enable, set in .env:\n" +
        "  EMBEDDING_URL=https://api.openai.com/v1/embeddings   (or http://localhost:11434/v1/embeddings for Ollama)\n" +
        "  EMBEDDING_MODEL=text-embedding-3-small               (or nomic-embed-text)\n" +
        "  EMBEDDING_KEY=sk-...                                 (omit for a local endpoint)",
    );
    return;
  }

  const items = await prisma.item.findMany({
    where: { type: { in: [...CONTENT_TYPES] } },
    select: { id: true, title: true, body: true, embedHash: true },
  });
  const stale = items.filter((i) => i.embedHash !== embedHash(i.title, i.body));
  if (!stale.length) {
    console.log(`Nothing to do: all ${items.length} notes are already embedded and unchanged.`);
    return;
  }

  console.log(`Embedding ${stale.length} of ${items.length} notes…`);
  let done = 0;
  for (let i = 0; i < stale.length; i += 64) {
    const batch = stale.slice(i, i + 64);
    const vectors = await embed(batch.map((b) => embedText(b.title, b.body)));
    if (!vectors) throw new Error("embedding call returned nothing");
    for (let j = 0; j < batch.length; j++) {
      await prisma.item.update({
        where: { id: batch[j].id },
        data: { embedding: serializeVector(vectors[j]), embedHash: embedHash(batch[j].title, batch[j].body) },
      });
    }
    done += batch.length;
    console.log(`  ${done}/${stale.length}`);
  }
  console.log("Done. Search now blends meaning with wording.");
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    prisma.$disconnect();
    process.exit(1);
  });

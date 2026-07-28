import { describe, it, expect, afterEach, vi } from "vitest";
import { embeddingsEnabled, serializeVector, parseVector, cosineVec, embedHash, embed } from "./embeddings";

afterEach(() => vi.unstubAllEnvs());

describe("configuration gate", () => {
  it("stays off unless both URL and model are set, so search degrades to lexical", async () => {
    vi.stubEnv("EMBEDDING_URL", undefined);
    vi.stubEnv("EMBEDDING_MODEL", undefined);
    expect(embeddingsEnabled()).toBe(false);
    expect(await embed(["anything"])).toBeNull();

    vi.stubEnv("EMBEDDING_URL", "http://localhost:11434/v1/embeddings");
    expect(embeddingsEnabled()).toBe(false); // model still missing
    vi.stubEnv("EMBEDDING_MODEL", "nomic-embed-text");
    expect(embeddingsEnabled()).toBe(true);
  });
});

describe("vector round-trip", () => {
  it("survives serialization and rejects junk", () => {
    const v = [0.1234567, -0.5, 0];
    expect(parseVector(serializeVector(v))).toEqual([0.123457, -0.5, 0]);
    expect(parseVector(null)).toBeNull();
    expect(parseVector("not json")).toBeNull();
    expect(parseVector("[]")).toBeNull();
  });
});

describe("cosineVec", () => {
  it("scores identical vectors 1 and orthogonal ones 0", () => {
    expect(cosineVec([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineVec([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineVec([1, 2, 3], [2, 4, 6])).toBeCloseTo(1); // direction, not magnitude
  });

  it("never divides by zero on an empty or zero vector", () => {
    expect(cosineVec([], [1, 2])).toBe(0);
    expect(cosineVec([0, 0], [1, 2])).toBe(0);
  });
});

describe("embedHash", () => {
  it("changes with the text, so a re-embed only touches what changed", () => {
    expect(embedHash("t", "b")).toBe(embedHash("t", "b"));
    expect(embedHash("t", "b")).not.toBe(embedHash("t", "b2"));
    expect(embedHash("t", "b")).not.toBe(embedHash("t2", "b"));
  });
});

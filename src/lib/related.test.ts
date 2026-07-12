import { describe, it, expect } from "vitest";
import { tokenize, buildCorpus, cosine, sharedTerms, detectCommunities } from "./related";

describe("tokenize", () => {
  it("drops stopwords, digits, and short tokens", () => {
    const t = tokenize("The auth token is valid for 30 days in the API");
    expect([...t.keys()].sort()).toEqual(["api", "auth", "days", "token", "valid"]);
  });
});

describe("buildCorpus + cosine", () => {
  const docs = [
    { id: "a", projectId: "p1", text: "prisma database schema migration postgres" },
    { id: "b", projectId: "p2", text: "postgres database schema and prisma migrations" },
    { id: "c", projectId: "p1", text: "css styling tailwind colors typography fonts" },
  ];
  const corpus = buildCorpus(docs);

  it("scores related docs above unrelated ones", () => {
    const ab = cosine(corpus.vectors.get("a")!, corpus.vectors.get("b")!);
    const ac = cosine(corpus.vectors.get("a")!, corpus.vectors.get("c")!);
    expect(ab).toBeGreaterThan(0.3);
    expect(ac).toBe(0);
  });

  it("explains a pair via its shared terms", () => {
    const why = sharedTerms(corpus.vectors.get("a")!, corpus.vectors.get("b")!);
    expect(why).toContain("postgres");
    expect(why).toContain("database");
    expect(why).not.toContain("css");
  });
});

describe("detectCommunities", () => {
  it("separates two obvious clusters and is deterministic", () => {
    // Two triangles joined by nothing.
    const edges = [
      { from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "a" },
      { from: "x", to: "y" }, { from: "y", to: "z" }, { from: "z", to: "x" },
    ];
    const nodes = ["a", "b", "c", "x", "y", "z"];
    const l1 = detectCommunities(nodes, edges);
    const l2 = detectCommunities(nodes, edges);
    expect(l1.get("a")).toBe(l1.get("b"));
    expect(l1.get("b")).toBe(l1.get("c"));
    expect(l1.get("x")).toBe(l1.get("y"));
    expect(l1.get("a")).not.toBe(l1.get("x"));
    expect([...l1.entries()]).toEqual([...l2.entries()]);
  });
});

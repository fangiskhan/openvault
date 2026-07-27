import { describe, it, expect } from "vitest";
import { queryTerms, snippet } from "./search";

// The retrieval bug this guards: an agent asking a natural question
// ("why no server-side AI") matched nothing under plain substring search,
// which reads as "the vault knows nothing" and sends the agent to the human.

describe("queryTerms", () => {
  it("keeps the meaningful words from a natural-language question", () => {
    // The compound is kept AND split, so either spelling in the note matches.
    expect(queryTerms("why no server-side AI")).toEqual(["server-side", "server", "side", "ai"]);
  });

  it("drops stopwords and one-character noise", () => {
    expect(queryTerms("what is the merge gate for")).toEqual(["merge", "gate"]);
  });

  it("keeps technical tokens intact", () => {
    const t = queryTerms("rate_limit c++ v1.2 node.js");
    expect(t).toContain("rate_limit");
    expect(t).toContain("c++");
    expect(t).toContain("node.js");
  });

  it("dedupes repeats and ignores punctuation-only input", () => {
    expect(queryTerms("token token TOKEN")).toEqual(["token"]);
    expect(queryTerms("?? -- ,")).toEqual([]);
  });
});

describe("snippet", () => {
  const body = "A long note about the merge gate. ".repeat(6) + "The reviewer approves before any push.";

  it("centres on the matched region rather than the head of the note", () => {
    expect(snippet(body, "reviewer approves")).toContain("reviewer approves");
  });

  it("falls back to a single matched term", () => {
    expect(snippet(body, "who approves the push")).toContain("approves");
  });

  it("falls back to the head when nothing matches", () => {
    expect(snippet(body, "unrelated")).toContain("A long note");
  });
});

import { describe, it, expect } from "vitest";
import { diffHunks } from "./diff";

const lines = (edits: Record<number, string> = {}, n = 200) =>
  Array.from({ length: n }, (_, i) => edits[i + 1] ?? `line ${i + 1}`).join("\n");

describe("diffHunks", () => {
  it("reports nothing for identical content", () => {
    expect(diffHunks("a\nb", "a\nb").kind).toBe("identical");
  });

  it("treats a CRLF/LF difference as no change at all", () => {
    // The failure this prevents: a Windows checkout holds CRLF while git stores
    // LF, so without normalization the first collision between a Windows agent
    // and a CI push reports every line as modified.
    const lf = "one\ntwo\nthree";
    expect(diffHunks(lf.replace(/\n/g, "\r\n"), lf).kind).toBe("identical");
  });

  it("finds two separate edits far apart in a large file", () => {
    const before = lines();
    const after = lines({ 50: "line 50 — ALICE", 150: "line 150 — BOB" });
    const d = diffHunks(before, after);
    expect(d.kind).toBe("hunks");
    if (d.kind !== "hunks") return;
    expect(d.hunks).toHaveLength(2);
    // Content-anchored: the snippet is what changed, plus context to locate it.
    expect(d.hunks[0].before).toContain("line 50");
    expect(d.hunks[0].after).toContain("line 50 — ALICE");
    expect(d.hunks[0].before).toContain("line 49"); // context
    expect(d.hunks[1].after).toContain("line 150 — BOB");
    // And it never mentions a coordinate that would go stale.
    expect(d.hunks[0].after).not.toMatch(/^\s*@@/m);
  });

  it("survives an insertion above a later edit — the case line numbers get wrong", () => {
    const before = lines();
    // Ten lines inserted at the top AND an edit further down. A line-number
    // record of "line 150" would now point at line 160's content.
    const after = ["new 1", "new 2", ...lines({ 150: "line 150 — CHANGED" }).split("\n")].join("\n");
    const d = diffHunks(before, after);
    expect(d.kind).toBe("hunks");
    if (d.kind !== "hunks") return;
    const all = d.hunks.map((h) => h.after).join("\n");
    expect(all).toContain("line 150 — CHANGED");
  });

  it("calls a wholesale rewrite a rewrite instead of emitting thousands of hunks", () => {
    const before = lines();
    const after = Array.from({ length: 200 }, (_, i) => `totally different ${i}`).join("\n");
    const d = diffHunks(before, after);
    expect(d.kind).toBe("rewritten");
  });

  it("caps hunk count and reports how many were folded", () => {
    const before = lines({}, 300);
    const edits: Record<number, string> = {};
    for (let i = 1; i <= 40; i++) edits[i * 5] = `changed ${i}`;
    const d = diffHunks(before, lines(edits, 300));
    expect(d.kind).toBe("hunks");
    if (d.kind !== "hunks") return;
    expect(d.hunks.length).toBeLessThanOrEqual(10);
    expect(d.more).toBeGreaterThan(0);
  });

  it("handles pure insertion and pure deletion", () => {
    const ins = diffHunks("a\nb\nc", "a\nb\nNEW\nc");
    expect(ins.kind).toBe("hunks");
    if (ins.kind === "hunks") expect(ins.hunks[0].after).toContain("NEW");

    const del = diffHunks("a\nb\nGONE\nc", "a\nb\nc");
    expect(del.kind).toBe("hunks");
    if (del.kind === "hunks") expect(del.hunks[0].before).toContain("GONE");
  });
});

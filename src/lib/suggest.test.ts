import { describe, it, expect } from "vitest";
import {
  validateEdits,
  applyEdits,
  stillApplies,
  looksApplied,
  editsFromContents,
  suggestionState,
  isCreateEdits,
  isDeleteEdits,
  createContent,
  DELETE_SENTINEL,
} from "./suggest";
import { hashContent } from "./code";

const FILE = `def get_llm_response(messages_context, image_input):
    if image_input:
        model_to_use = getattr(constants, 'VISION_MODEL')
        last_msg = messages_context[-1]
    return call(model_to_use)`;

const PIN_VISION = {
  before: "        model_to_use = getattr(constants, 'VISION_MODEL')",
  after: '        # FORCE gpt-4o for images\n        model_to_use = "gpt-4o"',
};

describe("validateEdits", () => {
  it("accepts an anchor that occurs exactly once", () => {
    const { ok, checks } = validateEdits(FILE, [PIN_VISION]);
    expect(ok).toBe(true);
    expect(checks[0].occurrences).toBe(1);
  });

  it("refuses an anchor that is no longer in the file", () => {
    const moved = FILE.replace("getattr(constants, 'VISION_MODEL')", '"gpt-4o"');
    const { ok, checks } = validateEdits(moved, [PIN_VISION]);
    expect(ok).toBe(false);
    expect(checks[0].reason).toMatch(/not in the file's current version/);
  });

  it("refuses an ambiguous anchor rather than guessing which one", () => {
    const twice = "x = 1\ny = 2\nx = 1\n";
    const { ok, checks } = validateEdits(twice, [{ before: "x = 1", after: "x = 99" }]);
    expect(ok).toBe(false);
    expect(checks[0].occurrences).toBe(2);
    expect(checks[0].reason).toMatch(/occurs 2 times/);
  });

  it("matches across a CRLF/LF difference", () => {
    // A Windows checkout stores CRLF; the mirror holds whatever was synced.
    // Anchoring on raw bytes would fail every match for one of the two.
    const crlf = FILE.replace(/\n/g, "\r\n");
    expect(validateEdits(crlf, [PIN_VISION]).ok).toBe(true);
  });

  it("validates edits in sequence, so a later anchor can depend on an earlier one", () => {
    const edits = [
      { before: "return call(model_to_use)", after: "return call(model_to_use, retries=3)" },
      { before: "retries=3", after: "retries=5" },
    ];
    expect(validateEdits(FILE, edits).ok).toBe(true);
    expect(applyEdits(FILE, edits)).toContain("retries=5");
  });

  it("rejects an empty anchor", () => {
    const { ok, checks } = validateEdits(FILE, [{ before: "   ", after: "x" }]);
    expect(ok).toBe(false);
    expect(checks[0].reason).toMatch(/empty/);
  });
});

describe("literal text handling — code is full of $", () => {
  // String.replace with a string second argument interprets $$, $&, $' and $`
  // as substitution patterns. Every one of these silently corrupted applied
  // content until replaceOnce.
  it("preserves $-substitution patterns in applied replacements", () => {
    const base = "a\nb\nc";
    const edits = [{ before: "b", after: "cost: $$total and $& and $' and $`" }];
    expect(validateEdits(base, edits).ok).toBe(true);
    expect(applyEdits(base, edits)).toBe("a\ncost: $$total and $& and $' and $`\nc");
  });

  it("a later edit can anchor on $-laden text an earlier edit wrote", () => {
    const base = "one\ntwo";
    const edits = [
      { before: "one", after: "cost: $$sum" },
      { before: "cost: $$sum\ntwo", after: "cost: $$sum\nthree" },
    ];
    expect(validateEdits(base, edits).ok).toBe(true);
    expect(applyEdits(base, edits)).toBe("cost: $$sum\nthree");
  });

  it("editsFromContents anchors cleanly next to a $$ line", () => {
    const base = ["l1", "total: $$sum", "l3", "l4", "l5"].join("\n");
    const edited = ["l1", "total: $$sum", "l3", "l4x", "l5"].join("\n");
    const plan = editsFromContents(base, edited);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(applyEdits(base, plan.edits)).toBe(edited);
  });
});

describe("overlapping anchors", () => {
  it("counts overlapping occurrences, refusing an anchor that could land in two places", () => {
    // "x\nx\nx" occurs at offsets 0 AND 2 of "x\nx\nx\nx" — non-overlapping
    // counting certified it unique and applied at the wrong spot.
    const v = validateEdits("x\nx\nx\nx", [{ before: "x\nx\nx", after: "y" }]);
    expect(v.ok).toBe(false);
    expect(v.checks[0].occurrences).toBe(2);
  });
});

describe("insert-after-anchor edits — the double-apply trap", () => {
  const edits = [{ before: "function foo() {", after: "function foo() {\n  log();" }];
  const applied = "function foo() {\n  log();\n  return 1;\n}";

  it("looksApplied recognises an applied insertion that keeps its anchor", () => {
    expect(looksApplied(applied, edits)).toBe(true);
    expect(looksApplied("function foo() {\n  return 1;\n}", edits)).toBe(false); // not yet applied
  });

  it("suggestionState refuses to re-apply an applied insertion", () => {
    // The anchor still validates against the applied file, so stillApplies
    // must be forced false — otherwise get_suggestion offers DOUBLED content.
    expect(suggestionState(applied, edits)).toEqual({ kind: "edit", stillApplies: false, applied: true });
  });
});

describe("editsFromContents — a working-copy diff becomes anchored edits", () => {
  const lines = (n: number, edits: Record<number, string> = {}) =>
    Array.from({ length: n }, (_, i) => edits[i + 1] ?? `line ${i + 1}`).join("\n");

  it("reports no changes for identical content (including CRLF-only differences)", () => {
    expect(editsFromContents("a\nb", "a\nb").ok).toBe(false);
    expect(editsFromContents("a\r\nb", "a\nb").ok).toBe(false);
  });

  it("one middle edit becomes one anchored edit that validates and applies", () => {
    const base = lines(50);
    const edited = lines(50, { 25: "line 25 — CHANGED" });
    const plan = editsFromContents(base, edited);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.edits).toHaveLength(1);
    expect(validateEdits(base, plan.edits).ok).toBe(true);
    expect(applyEdits(base, plan.edits)).toBe(edited);
  });

  it("two distant edits become two independent anchored edits", () => {
    const base = lines(200);
    const edited = lines(200, { 50: "line 50 — ALICE", 150: "line 150 — BOB" });
    const plan = editsFromContents(base, edited);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.edits).toHaveLength(2);
    expect(applyEdits(base, plan.edits)).toBe(edited);
  });

  it("widens context until a repeated region anchors unambiguously", () => {
    // Alternating identical lines: narrow context matches more than once, so
    // the generator must keep widening instead of filing an ambiguous edit.
    const base = ["A", "B", "A", "B", "A", "B", "A", "B"].join("\n");
    const edited = ["A", "B", "A", "C", "A", "B", "A", "B"].join("\n");
    const plan = editsFromContents(base, edited);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(validateEdits(base, plan.edits).ok).toBe(true);
    expect(applyEdits(base, plan.edits)).toBe(edited);
  });

  it("handles a CRLF working copy against an LF base", () => {
    const base = lines(30);
    const edited = lines(30, { 15: "line 15 — WIN" }).replace(/\n/g, "\r\n");
    const plan = editsFromContents(base, edited);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(applyEdits(base, plan.edits)).toBe(lines(30, { 15: "line 15 — WIN" }));
  });

  it("handles appending at the end of the file", () => {
    const base = lines(10);
    const edited = base + "\nline 11 — appended";
    const plan = editsFromContents(base, edited);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(applyEdits(base, plan.edits)).toBe(edited);
  });

  it("falls back to one whole-file edit when the span is too large to diff", () => {
    // Every line changed in a 1,500-line file: past the LCS cost guard, so the
    // plan degrades to a single whole-file replacement rather than failing.
    const base = lines(1500);
    const edited = Array.from({ length: 1500 }, (_, i) => `new ${i + 1}`).join("\n");
    const plan = editsFromContents(base, edited);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.edits).toHaveLength(1);
    expect(plan.edits[0].before).toBe(base);
    expect(applyEdits(base, plan.edits)).toBe(edited);
  });
});

describe("create proposals — a file the mirror does not have", () => {
  const CREATE = [{ before: "", after: "export const NEW = 1;" }];

  it("recognises the create form and rejects lookalikes", () => {
    expect(isCreateEdits(CREATE)).toBe(true);
    expect(isCreateEdits([{ before: "", after: "  " }])).toBe(false); // empty content
    expect(isCreateEdits([...CREATE, { before: "x", after: "y" }])).toBe(false); // mixed
  });

  it("applies while the path is absent, is applied once the exact content exists", () => {
    expect(suggestionState(null, CREATE)).toEqual({ kind: "create", stillApplies: true, applied: false });
    expect(suggestionState("export const NEW = 1;", CREATE)).toEqual({ kind: "create", stillApplies: false, applied: true });
    expect(suggestionState("something else", CREATE)).toEqual({ kind: "create", stillApplies: false, applied: false });
  });

  it("tolerates the trailing newline a formatter adds to the applied file", () => {
    expect(suggestionState("export const NEW = 1;\n", CREATE).applied).toBe(true);
  });

  it("treats filling an EMPTY mirrored file as a create that still applies", () => {
    expect(suggestionState("", CREATE)).toEqual({ kind: "create", stillApplies: true, applied: false });
    expect(suggestionState("  \n", CREATE).stillApplies).toBe(true);
  });

  it("rejects an invisible zero-width body", () => {
    expect(isCreateEdits([{ before: "", after: "​" }])).toBe(false);
    expect(isCreateEdits([{ before: "", after: "﻿‍" }])).toBe(false);
  });

  it("an ordinary edit against a missing file neither applies nor is applied", () => {
    expect(suggestionState(null, [{ before: "a", after: "b" }])).toEqual({ kind: "edit", stillApplies: false, applied: false });
  });
});

describe("multi-part creates — one big file, one suggestion", () => {
  const PARTS = [
    { before: "", after: "// part one\n" },
    { before: "", after: "// part two\n" },
  ];

  it("recognises a multi-part create and joins its content in order", () => {
    expect(isCreateEdits(PARTS)).toBe(true);
    expect(createContent(PARTS)).toBe("// part one\n// part two\n");
  });

  it("multi-part applied detection compares against the JOINED content", () => {
    expect(suggestionState(null, PARTS).stillApplies).toBe(true);
    expect(suggestionState("// part one\n// part two\n", PARTS).applied).toBe(true);
    expect(suggestionState("// part one\n", PARTS).applied).toBe(false); // half a file is not applied
  });

  it("a mixed batch (one empty before among real edits) is NOT a create", () => {
    expect(isCreateEdits([{ before: "", after: "x" }, { before: "a", after: "b" }])).toBe(false);
  });
});

describe("deletion proposals", () => {
  const FILE = "old code\nnobody needs\n";

  it("the sentinel is unmistakable: not a create, not a valid edit", () => {
    expect(isDeleteEdits(DELETE_SENTINEL)).toBe(true);
    expect(isCreateEdits(DELETE_SENTINEL)).toBe(false); // no visible content
    expect(validateEdits(FILE, DELETE_SENTINEL).ok).toBe(false); // empty before
  });

  it("applies while the file is unchanged, goes stale when it changes, applied when gone", () => {
    const base = hashContent(FILE);
    expect(suggestionState(FILE, DELETE_SENTINEL, base)).toEqual({ kind: "delete", stillApplies: true, applied: false });
    // Someone edited the file after deletion was proposed: what would be
    // removed is no longer what the author saw. Stale, not deletable.
    expect(suggestionState(FILE + "new line\n", DELETE_SENTINEL, base).stillApplies).toBe(false);
    // File gone: the deletion happened (however it happened). Done.
    expect(suggestionState(null, DELETE_SENTINEL, base)).toEqual({ kind: "delete", stillApplies: false, applied: true });
  });
});

describe("staleness and self-closing", () => {
  it("stops applying once someone else changes that exact code", () => {
    expect(stillApplies(FILE, [PIN_VISION])).toBe(true);
    const changed = FILE.replace("VISION_MODEL", "IMAGE_MODEL");
    expect(stillApplies(changed, [PIN_VISION])).toBe(false);
  });

  it("recognises its own change once the owner has applied and pushed it", () => {
    expect(looksApplied(FILE, [PIN_VISION])).toBe(false);
    const applied = applyEdits(FILE, [PIN_VISION]);
    expect(looksApplied(applied, [PIN_VISION])).toBe(true);
  });
});

import { describe, it, expect } from "vitest";
import { validateEdits, applyEdits, stillApplies, looksApplied } from "./suggest";

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

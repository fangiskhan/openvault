import { describe, it, expect } from "vitest";
import { withRelatedLinks } from "./index";

// The failure this guards: an imported note could only reach an existing topic
// hub if the agent happened to type the right [[wikilink]]. Every import that
// forgot would land as an island, and the hub would never gain a backlink.

const hub = {
  title: "TTS and voice",
  body: "Text to speech, voice cloning, lip sync and audio latency work across the bots.",
};
const unrelated = { title: "Billing and invoices", body: "Invoice templates, payment terms, accounting exports." };

describe("withRelatedLinks — joining the existing graph", () => {
  it("links a new note to the existing hub that covers its topic", () => {
    const [note] = withRelatedLinks(
      [{ title: "Voice latency fix", body: "Cut the lip sync delay in the speech pipeline; audio and voice timing." }],
      [hub, unrelated],
    );
    expect(note.body).toContain("## Related");
    expect(note.body).toContain("[[TTS and voice]]");
    expect(note.body).not.toContain("[[Billing and invoices]]");
  });

  it("adds nothing when the vault holds nothing similar", () => {
    const [note] = withRelatedLinks([{ title: "Voice latency fix", body: "Lip sync delay." }], [unrelated]);
    expect(note.body).not.toContain("## Related");
  });

  it("still cross-links notes inside the batch", () => {
    const notes = withRelatedLinks(
      [
        { title: "Alpha", body: "prisma database schema migration postgres" },
        { title: "Beta", body: "prisma database schema migration postgres" },
        { title: "Gamma", body: "prisma database schema migration postgres" },
      ],
      [],
    );
    expect(notes[0].body).toContain("[[Beta]]");
  });

  it("never links a note to itself and never stacks Related blocks", () => {
    const first = withRelatedLinks([{ title: "Voice latency fix", body: "voice speech audio lip sync" }], [hub]);
    const second = withRelatedLinks(first, [hub]);
    expect(second[0].body).not.toContain("[[Voice latency fix]]");
    expect(second[0].body.match(/## Related/g)).toHaveLength(1);
  });
});

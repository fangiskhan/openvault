import { splitLines } from "./diff";

// Verification for proposed code changes.
//
// A suggestion is only worth anything if the server can confirm it describes
// the file as it ACTUALLY is. An agent sends "replace this text with that
// text"; before storing it we check the 'before' text really occurs in the
// current mirror, exactly once. That single check buys three things:
//
//   - staleness is detected, not assumed: if the anchor is gone, the file moved
//     and the suggestion cannot be applied blind;
//   - ambiguity is refused: an anchor matching twice would apply somewhere the
//     author did not mean;
//   - nobody can propose a change to code that was never there.
//
// This is the same contract an editing tool has with old_string/new_string, and
// it is why the edits are text rather than line numbers — a line number would
// still "resolve" against a file that had shifted underneath it.

export type Edit = { before: string; after: string };
export type EditCheck = { index: number; ok: boolean; occurrences: number; reason?: string };

export const MAX_EDITS = 20;
export const MAX_EDIT_CHARS = 20_000;

// Line endings differ between a Windows checkout (CRLF) and git's stored form
// (LF). Anchoring on raw bytes would fail every match for one of the two.
const norm = (s: string) => s.replace(/\r\n/g, "\n");

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count++;
    from = at + needle.length;
  }
}

export function validateEdits(content: string, edits: Edit[]): { checks: EditCheck[]; ok: boolean } {
  const checks: EditCheck[] = [];
  // Applied in order against a running copy, because edit 2's anchor may only
  // exist after edit 1 has been applied.
  let running = norm(content);
  edits.forEach((e, index) => {
    const before = norm(e.before);
    const after = norm(e.after);
    if (!before.trim()) {
      checks.push({ index, ok: false, occurrences: 0, reason: "the 'before' text is empty — anchor on the exact code being replaced" });
      return;
    }
    if (before.length > MAX_EDIT_CHARS || after.length > MAX_EDIT_CHARS) {
      checks.push({ index, ok: false, occurrences: 0, reason: `each side must be under ${MAX_EDIT_CHARS} characters` });
      return;
    }
    const occurrences = countOccurrences(running, before);
    if (occurrences === 0) {
      checks.push({
        index,
        ok: false,
        occurrences,
        reason: "that text is not in the file's current version — read_code it again; it may have been changed or already applied",
      });
      return;
    }
    if (occurrences > 1) {
      checks.push({
        index,
        ok: false,
        occurrences,
        reason: `that text occurs ${occurrences} times — include surrounding lines so it identifies one place`,
      });
      return;
    }
    running = running.replace(before, after);
    checks.push({ index, ok: true, occurrences });
  });
  return { checks, ok: checks.every((c) => c.ok) };
}

// The content that would result from applying every edit. Only meaningful when
// validateEdits returned ok.
export function applyEdits(content: string, edits: Edit[]): string {
  let out = norm(content);
  for (const e of edits) out = out.replace(norm(e.before), norm(e.after));
  return out;
}

// Whether a stored suggestion still fits the file as it stands now. Recomputed
// on read rather than stored, because the mirror moves and a cached verdict
// would be exactly the kind of confidently-stale answer this design exists to
// avoid.
export function stillApplies(content: string, edits: Edit[]): boolean {
  return validateEdits(content, edits).ok;
}

// Already in the tree? If every 'after' is present and no 'before' remains, the
// owner applied this and pushed; CI then mirrored it. Lets a suggestion close
// itself instead of lingering as open work that is actually finished.
export function looksApplied(content: string, edits: Edit[]): boolean {
  const c = norm(content);
  return edits.every((e) => c.includes(norm(e.after)) && !c.includes(norm(e.before)));
}

// A compact human/agent-readable rendering for review.
export function renderEdits(path: string, edits: Edit[]): string {
  const body = edits
    .map((e, i) => `### edit ${i + 1}\n\n\`\`\`\n- ${splitLines(e.before).join("\n- ")}\n\`\`\`\n\n\`\`\`\n+ ${splitLines(e.after).join("\n+ ")}\n\`\`\``)
    .join("\n\n");
  return `**${path}**\n\n${body}`;
}

import { splitLines, lcsPairs, MAX_LCS_LINES } from "./diff";
import { hashContent } from "./code";

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
    // Advance one character, not the needle length: occurrences may OVERLAP
    // ("x\nx\nx" occurs twice in "x\nx\nx\nx"), and an anchor that could land
    // in two places must be reported as ambiguous, not certified unique.
    from = at + 1;
  }
}

// Replace the first occurrence LITERALLY. String.replace with a string second
// argument interprets $$, $&, $' and $` as substitution patterns — so applying
// an edit whose replacement contains a Makefile's $$HOME, a JS "$&" pattern, or
// LaTeX $$ would silently corrupt the exact text being written, at the exact
// moment it was being applied.
function replaceOnce(text: string, needle: string, replacement: string): string {
  const at = text.indexOf(needle);
  return at === -1 ? text : text.slice(0, at) + replacement + text.slice(at + needle.length);
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
    running = replaceOnce(running, before, after);
    checks.push({ index, ok: true, occurrences });
  });
  return { checks, ok: checks.every((c) => c.ok) };
}

// The content that would result from applying every edit. Only meaningful when
// validateEdits returned ok.
export function applyEdits(content: string, edits: Edit[]): string {
  let out = norm(content);
  for (const e of edits) out = replaceOnce(out, norm(e.before), norm(e.after));
  return out;
}

// Whether a stored suggestion still fits the file as it stands now. Recomputed
// on read rather than stored, because the mirror moves and a cached verdict
// would be exactly the kind of confidently-stale answer this design exists to
// avoid.
export function stillApplies(content: string, edits: Edit[]): boolean {
  return validateEdits(content, edits).ok;
}

// Already in the tree? The owner applied this and pushed; CI then mirrored it.
// Lets a suggestion close itself instead of lingering as open work that is
// actually finished.
export function looksApplied(content: string, edits: Edit[]): boolean {
  const c = norm(content);
  return edits.every((e) => {
    const before = norm(e.before);
    const after = norm(e.after);
    if (!c.includes(after)) return false;
    // An insert-after-anchor edit KEEPS its anchor: after contains before, so
    // the anchor surviving is exactly what applied looks like, not evidence it
    // was never applied. Only an edit that removes its anchor can use "the
    // anchor is still there" as proof of unapplied.
    return after.includes(before) ? true : !c.includes(before);
  });
}

// A compact human/agent-readable rendering for review.
export function renderEdits(path: string, edits: Edit[]): string {
  if (isDeleteEdits(edits)) return `**${path}**\n\n### delete this file`;
  const parts = edits.length;
  const body = edits
    .map((e, i) =>
      e.before === ""
        ? `### ${parts > 1 ? `new file, part ${i + 1}/${parts}` : "new file"}\n\n\`\`\`\n+ ${splitLines(e.after).join("\n+ ")}\n\`\`\``
        : `### edit ${i + 1}\n\n\`\`\`\n- ${splitLines(e.before).join("\n- ")}\n\`\`\`\n\n\`\`\`\n+ ${splitLines(e.after).join("\n+ ")}\n\`\`\``,
    )
    .join("\n\n");
  return `**${path}**\n\n${body}`;
}

// A create proposal: the file is not in the mirror, so there is nothing to
// anchor on. Every edit has an empty before; the file's content is the afters
// CONCATENATED in order. One part is the common case; several parts let a file
// larger than MAX_EDIT_CHARS travel as one reviewable suggestion instead of
// being split across coupled proposals (the 52k stylesheet problem).
//
// The content gate strips zero-width characters before trimming: trim() does
// not remove U+200B/U+200C/U+200D/U+FEFF, so without this an "invisible" file
// consisting of one zero-width space passes as real content.
export function isCreateEdits(edits: Edit[]): boolean {
  return (
    edits.length >= 1 &&
    edits.every((e) => e.before === "" && typeof e.after === "string") &&
    createContent(edits).replace(/[\u200B-\u200D\uFEFF]/g, "").trim().length > 0
  );
}

// The full content a create proposal carries: its parts, joined in order.
export function createContent(edits: Edit[]): string {
  return edits.map((e) => e.after ?? "").join("");
}

// A delete proposal: "remove this file". Encoded as the one edit shape that is
// impossible for both other kinds \u2014 a single entry with BOTH sides empty (an
// edit needs a non-empty before; a create needs visible content) \u2014 so legacy
// rows can never be misread and no schema change is needed.
export const DELETE_SENTINEL: Edit[] = [{ before: "", after: "" }];
export function isDeleteEdits(edits: Edit[]): boolean {
  return edits.length === 1 && edits[0].before === "" && edits[0].after === "";
}

// One verdict for every handler that needs to know whether a stored suggestion
// still fits the world: list, get, and the approval gate. Centralised because
// create proposals invert the meaning of "the file exists" — for an edit,
// existence is a precondition; for a create, it is the failure (or, if the
// content matches, the proof it was applied).
export function suggestionState(
  currentContent: string | null,
  edits: Edit[],
  baseHash?: string | null,
): { kind: "create" | "edit" | "delete"; stillApplies: boolean; applied: boolean } {
  if (isDeleteEdits(edits)) {
    // For a deletion, ABSENCE is success: the file being gone means the owner
    // did it (or it went another way — either way there is nothing left to do).
    if (currentContent === null) return { kind: "delete", stillApplies: false, applied: true };
    // Present, but changed since the deletion was proposed? Then the proposer
    // was looking at a different file than the one that would now be deleted —
    // stale, exactly like an edit whose anchor moved. Without a recorded hash
    // (should not happen) stay permissive rather than wedging the proposal.
    const stillApplies = baseHash ? hashContent(currentContent) === baseHash : true;
    return { kind: "delete", stillApplies, applied: false };
  }
  if (isCreateEdits(edits)) {
    // An EMPTY mirrored file counts as absent: a placeholder like __init__.py
    // has no text an ordinary edit could anchor on, so without this the file
    // could never grow through the suggestion pipeline at all.
    if (currentContent === null || !norm(currentContent).trim()) {
      return { kind: "create", stillApplies: true, applied: false };
    }
    // Trailing-newline tolerance: a formatter appending "\n" to the applied
    // file is the near-universal case, and it must read as applied — not as
    // "a different file now exists".
    const applied = norm(currentContent).replace(/\n+$/, "") === norm(createContent(edits)).replace(/\n+$/, "");
    return { kind: "create", stillApplies: false, applied };
  }
  if (currentContent === null) return { kind: "edit", stillApplies: false, applied: false };
  const applied = looksApplied(currentContent, edits);
  // Applied means DONE. An insert-style edit whose anchor survives in the
  // applied file would still pass validateEdits, and reporting it as
  // still-appliable invites a second application — which duplicates the
  // inserted text. Once applied, nothing about this suggestion applies again.
  return { kind: "edit", stillApplies: applied ? false : validateEdits(currentContent, edits).ok, applied };
}

// Turn a base/edited pair of file contents into content-anchored edits that
// validateEdits will accept — the machinery behind scripts/propose-changes.ts,
// which lets an agent edit a materialised working copy with its normal file
// tools and have the diff filed as suggestions automatically.
//
// The interesting problem is uniqueness: each 'before' block must occur
// exactly once in the base, or the suggestion is refused (rightly). So hunks
// start with two lines of context and widen until they are unambiguous,
// merging with neighbours when their context windows collide. If no widening
// makes every hunk unique — or the change is too scattered or too large to
// anchor — fall back to proposing the whole file, and if even that exceeds the
// per-edit cap, say so rather than filing something that cannot apply.
const CONTEXT_STEPS = [2, 5, 8, 11, 14];

export type ProposalPlan = { ok: true; edits: Edit[] } | { ok: false; reason: string };

export function editsFromContents(baseText: string, editedText: string): ProposalPlan {
  const a = splitLines(baseText);
  const b = splitLines(editedText);
  const base = a.join("\n");
  const edited = b.join("\n");
  if (base === edited) return { ok: false, reason: "no changes" };

  const whole = (): ProposalPlan => {
    if (!base.trim()) return { ok: false, reason: "the base file is empty — nothing to anchor on" };
    if (base.length > MAX_EDIT_CHARS || edited.length > MAX_EDIT_CHARS) {
      return { ok: false, reason: "the change is too large or too scattered to anchor as edits; propose it manually in parts" };
    }
    // The fallback gets the SAME identity guarantee as the hunked path: a plan
    // is only a plan if applying it reproduces the edited file exactly.
    const edits: Edit[] = [{ before: base, after: edited }];
    return validateEdits(base, edits).ok && applyEdits(base, edits) === edited
      ? { ok: true, edits }
      : { ok: false, reason: "could not build a verifiable whole-file replacement" };
  };

  // Trim the shared head and tail so the LCS runs only over the differing span.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  if (midA.length > MAX_LCS_LINES || midB.length > MAX_LCS_LINES) return whole();

  // Runs of divergence between LCS anchor points, in document order.
  type Run = { a0: number; a1: number; b0: number; b1: number };
  const runs: Run[] = [];
  {
    let ia = 0;
    let ib = 0;
    for (const [pa, pb] of lcsPairs(midA, midB)) {
      if (pa > ia || pb > ib) runs.push({ a0: ia, a1: pa, b0: ib, b1: pb });
      ia = pa + 1;
      ib = pb + 1;
    }
    if (ia < midA.length || ib < midB.length) runs.push({ a0: ia, a1: midA.length, b0: ib, b1: midB.length });
  }

  for (const ctx of CONTEXT_STEPS) {
    // Merge runs whose context windows would overlap — otherwise two nearby
    // hunks each claim the same context lines and neither anchors uniquely.
    const merged: Run[] = [];
    for (const r of runs) {
      const last = merged[merged.length - 1];
      if (last && (r.a0 - last.a1 <= ctx * 2 || r.b0 - last.b1 <= ctx * 2)) {
        last.a1 = r.a1;
        last.b1 = r.b1;
      } else {
        merged.push({ ...r });
      }
    }
    if (merged.length > MAX_EDITS) continue; // wider context merges more; retry

    const edits: Edit[] = merged.map((r) => ({
      before: a.slice(Math.max(0, head + r.a0 - ctx), Math.min(a.length, head + r.a1 + ctx)).join("\n"),
      after: b.slice(Math.max(0, head + r.b0 - ctx), Math.min(b.length, head + r.b1 + ctx)).join("\n"),
    }));
    if (edits.some((e) => e.before.length > MAX_EDIT_CHARS || e.after.length > MAX_EDIT_CHARS)) return whole();
    if (edits.some((e) => !e.before.trim())) continue; // e.g. insertion with no context yet — widen

    // The plan is only a plan if it validates AND reproduces the edited file
    // exactly. The second check is cheap insurance against ordering subtleties
    // in sequential replace-first-occurrence application.
    if (validateEdits(base, edits).ok && applyEdits(base, edits) === edited) return { ok: true, edits };
  }
  return whole();
}

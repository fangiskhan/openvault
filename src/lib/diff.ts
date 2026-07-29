// Minimal line diff, used to tell an agent WHAT changed underneath it when its
// push is refused.
//
// The output is deliberately content-anchored — "this block became that block"
// — never line numbers. A line number stops being true the moment anyone
// inserts a line above it, and nothing detects that: the coordinate still
// resolves, it just points at the wrong code. A snippet can be searched for,
// and when it is genuinely gone the agent finds nothing instead of finding a
// lie. This is the same reason unified diffs carry context lines.
//
// The hunks are computed by the SERVER from two stored versions, so no agent
// has to remember to record what it did and none can misreport it.

const MAX_LCS_LINES = 1200; // past this, report coarsely rather than slowly
const MAX_HUNKS = 10;
const MAX_HUNK_LINES = 40;
const REWRITE_FRACTION = 0.6;
const CONTEXT = 2;

export type Hunk = { before: string; after: string };
export type DiffResult =
  | { kind: "identical" }
  | { kind: "rewritten"; changedLines: number; totalLines: number }
  | { kind: "hunks"; hunks: Hunk[]; more: number };

// CRLF vs LF is not a change. Windows checkouts hold CRLF while git stores LF,
// so without this the first collision between a Windows agent and a CI push
// reports every single line as modified.
export const splitLines = (s: string): string[] => s.replace(/\r\n/g, "\n").split("\n");

// Longest common subsequence over two line arrays, returned as the set of
// indices to keep on each side. Only called on the differing middle, after the
// shared head and tail are trimmed, so the matrix stays small for normal edits.
function lcsPairs(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const dp = new Int32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] =
        a[i] === b[j]
          ? dp[(i + 1) * (m + 1) + j + 1] + 1
          : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

const clamp = (block: string[]): string =>
  block.length > MAX_HUNK_LINES
    ? [...block.slice(0, MAX_HUNK_LINES), `… ${block.length - MAX_HUNK_LINES} more line(s)`].join("\n")
    : block.join("\n");

export function diffHunks(beforeText: string, afterText: string): DiffResult {
  if (beforeText === afterText) return { kind: "identical" };
  const a = splitLines(beforeText);
  const b = splitLines(afterText);

  // Trim the shared head and tail. Two edits far apart in a large file collapse
  // to the span between them, which is what keeps the matrix affordable.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  if (!midA.length && !midB.length) return { kind: "identical" };

  const total = Math.max(a.length, b.length);
  // Cost guard, not a judgement about the content: the matrix below is
  // quadratic, so an enormous divergent span is reported coarsely rather than
  // slowly.
  if (midA.length > MAX_LCS_LINES || midB.length > MAX_LCS_LINES) {
    return { kind: "rewritten", changedLines: Math.max(midA.length, midB.length), totalLines: total };
  }

  const pairs = lcsPairs(midA, midB);

  // Count what ACTUALLY differs, not the distance between the first and last
  // difference. Two one-line edits at opposite ends of a file span almost the
  // whole file while changing two lines; judging by the span called that a
  // rewrite and threw the detail away.
  const changedLines = midA.length - pairs.length + (midB.length - pairs.length);
  // A reformat, a line-ending flip or a generated artifact rewrites nearly
  // everything. Emitting thousands of hunks for that is noise, not information.
  if (total > 0 && changedLines / total > REWRITE_FRACTION) {
    return { kind: "rewritten", changedLines, totalLines: total };
  }

  // Walk the LCS, collecting maximal runs where the two sides diverge. Context
  // is sliced from the FULL arrays, not the trimmed middle: the lines that
  // locate a hunk usually live in the shared prefix that was just trimmed away,
  // and a snippet with no surrounding context is far harder to find again.
  const hunks: Hunk[] = [];
  let ia = 0;
  let ib = 0;
  const flush = (endA: number, endB: number) => {
    if (endA === ia && endB === ib) return;
    const fromA = head + ia;
    const fromB = head + ib;
    const beforeBlock = a.slice(Math.max(0, fromA - CONTEXT), Math.min(a.length, head + endA + CONTEXT));
    const afterBlock = b.slice(Math.max(0, fromB - CONTEXT), Math.min(b.length, head + endB + CONTEXT));
    hunks.push({ before: clamp(beforeBlock), after: clamp(afterBlock) });
  };
  for (const [pa, pb] of pairs) {
    if (pa > ia || pb > ib) flush(pa, pb);
    ia = pa + 1;
    ib = pb + 1;
  }
  if (ia < midA.length || ib < midB.length) flush(midA.length, midB.length);

  if (!hunks.length) return { kind: "identical" };
  const more = Math.max(0, hunks.length - MAX_HUNKS);
  return { kind: "hunks", hunks: hunks.slice(0, MAX_HUNKS), more };
}

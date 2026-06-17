import { describe, it, expect } from "vitest";
import { classify, labelFor } from "./attention";

const now = new Date("2026-06-18T00:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
const daysAhead = (n: number) => new Date(now.getTime() + n * 86_400_000);
const base = { type: "task", status: null, dueAt: null, closedAt: null, updatedAt: now };

describe("classify", () => {
  it("flags a blocked + overdue task as a Critical overdue_blocker", () => {
    const c = classify({ ...base, status: "blocked", dueAt: daysAgo(3) }, now);
    expect(c?.kind).toBe("overdue_blocker");
    expect(labelFor(c!.score)).toBe("Critical");
  });

  it("flags an open risk", () => {
    expect(classify({ ...base, type: "risk", status: "open" }, now)?.kind).toBe("open_risk");
  });

  it("flags an overdue task", () => {
    expect(classify({ ...base, dueAt: daysAgo(1) }, now)?.kind).toBe("overdue");
  });

  it("flags a due-soon task", () => {
    expect(classify({ ...base, dueAt: daysAhead(2) }, now)?.kind).toBe("due_soon");
  });

  it("flags a stale open task", () => {
    expect(classify({ ...base, updatedAt: daysAgo(30) }, now)?.kind).toBe("stale");
  });

  it("ignores a done task even if overdue", () => {
    expect(classify({ ...base, status: "done", dueAt: daysAgo(5) }, now)).toBeNull();
  });

  it("ignores a closed risk", () => {
    expect(classify({ ...base, type: "risk", status: "closed" }, now)).toBeNull();
  });

  it("ignores a healthy task due far in the future", () => {
    expect(classify({ ...base, dueAt: daysAhead(30) }, now)).toBeNull();
  });
});

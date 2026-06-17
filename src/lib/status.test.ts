import { describe, it, expect } from "vitest";
import { ragFrom } from "./status";
import type { SignalKind } from "./attention";

const sig = (kind: SignalKind) => ({ kind });

describe("ragFrom", () => {
  it("is green with no signals", () => {
    expect(ragFrom([])).toBe("green");
  });

  it("is amber for an open risk", () => {
    expect(ragFrom([sig("open_risk")])).toBe("amber");
  });

  it("is amber for a blocker, overdue, or due-soon", () => {
    expect(ragFrom([sig("blocker")])).toBe("amber");
    expect(ragFrom([sig("overdue")])).toBe("amber");
    expect(ragFrom([sig("due_soon")])).toBe("amber");
  });

  it("is red for a blocked + overdue item", () => {
    expect(ragFrom([sig("overdue_blocker")])).toBe("red");
  });

  it("lets red win over amber", () => {
    expect(ragFrom([sig("open_risk"), sig("overdue_blocker")])).toBe("red");
  });
});

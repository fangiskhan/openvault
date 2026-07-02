import { describe, it, expect } from "vitest";
import { newToken, hashToken } from "./accounts";

// The at-rest guarantee: what the DB stores (hashToken) must be a stable
// one-way digest of what the caller presents (newToken), never the key itself.

describe("newToken", () => {
  it("mints a prefixed 192-bit random key", () => {
    const t = newToken();
    expect(t).toMatch(/^ovk_[0-9a-f]{48}$/);
    expect(newToken()).not.toBe(t);
  });
});

describe("hashToken", () => {
  it("is deterministic and never stores the plaintext", () => {
    const t = newToken();
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(t)).not.toContain(t);
  });

  it("differs for different tokens", () => {
    expect(hashToken("ovk_a")).not.toBe(hashToken("ovk_b"));
  });
});

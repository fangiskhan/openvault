import { describe, it, expect } from "vitest";
import { isValidRepoPath, normalizeRepoPath, hashContent, pathOverlap } from "./code";

// sync_code takes paths straight from agents, so the validator is the only
// thing between a hostile/buggy client and junk (or traversal) keys in the DB.

describe("isValidRepoPath", () => {
  it("accepts normal repo paths (either separator)", () => {
    expect(isValidRepoPath("src/lib/auth.ts")).toBe(true);
    expect(isValidRepoPath("src\\lib\\auth.ts")).toBe(true);
    expect(isValidRepoPath("README.md")).toBe(true);
    expect(isValidRepoPath(".env.example")).toBe(true);
    expect(isValidRepoPath("packages/@scope/pkg/index.js")).toBe(true);
  });

  it("accepts framework-standard route segments", () => {
    expect(isValidRepoPath("src/app/api/items/[id]/route.ts")).toBe(true);
    expect(isValidRepoPath("src/app/[...slug]/page.tsx")).toBe(true);
    expect(isValidRepoPath("src/app/(dashboard)/layout.tsx")).toBe(true);
    expect(isValidRepoPath("src/routes/+page.svelte")).toBe(true);
    // ...but a bare ".." segment is still traversal even with the wider charset
    expect(isValidRepoPath("src/[id]/../secrets")).toBe(false);
  });

  it("rejects traversal, absolute paths, and junk", () => {
    expect(isValidRepoPath("../secrets.txt")).toBe(false);
    expect(isValidRepoPath("src/../../etc/passwd")).toBe(false);
    expect(isValidRepoPath("/etc/passwd")).toBe(false);
    expect(isValidRepoPath("C:/Windows/system32")).toBe(false);
    expect(isValidRepoPath("")).toBe(false);
    expect(isValidRepoPath("a b/c.txt")).toBe(false);
    expect(isValidRepoPath("x".repeat(401))).toBe(false);
  });
});

describe("normalizeRepoPath", () => {
  it("normalizes separators and leading ./", () => {
    expect(normalizeRepoPath(".\\src\\a.ts")).toBe("src/a.ts");
    expect(normalizeRepoPath("./src//a.ts")).toBe("src/a.ts");
  });
});

describe("hashContent / pathOverlap", () => {
  it("hashes deterministically", () => {
    expect(hashContent("x")).toBe(hashContent("x"));
    expect(hashContent("x")).not.toBe(hashContent("y"));
  });

  it("finds overlapping paths across separators", () => {
    expect(pathOverlap(["src/a.ts", "src/b.ts"], ["src\\b.ts", "src/c.ts"])).toEqual(["src/b.ts"]);
    expect(pathOverlap(["src/a.ts"], ["src/c.ts"])).toEqual([]);
  });
});

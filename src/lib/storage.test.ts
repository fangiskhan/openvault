import { describe, it, expect } from "vitest";
import path from "node:path";
import { safeStorageName, resolveUnderRoot } from "./storage";

// The upload path is the one place untrusted bytes (a filename) become part of a
// filesystem path, so these two guards are what stand between it and an
// arbitrary-file-write. They must hold for every hostile shape.

describe("safeStorageName", () => {
  it("keeps an ordinary filename intact", () => {
    expect(safeStorageName("Q4-report.xlsx")).toBe("Q4-report.xlsx");
  });

  it("strips POSIX and Windows directory components", () => {
    expect(safeStorageName("../../etc/passwd")).toBe("passwd");
    expect(safeStorageName("..\\..\\Windows\\system32\\evil.dll")).toBe("evil.dll");
    expect(safeStorageName("/absolute/path/file.txt")).toBe("file.txt");
  });

  it("neutralizes a leading-dots traversal that survives basename", () => {
    // "foo/.." reduces to ".." as a basename — must not be usable as a key.
    expect(safeStorageName("foo/..")).not.toBe("..");
    expect(safeStorageName("..")).not.toContain("..");
  });

  it("replaces unsafe characters and never returns empty", () => {
    expect(safeStorageName("a b:c*?.txt")).toBe("a_b_c__.txt");
    expect(safeStorageName("")).toBe("file");
    expect(safeStorageName("///")).toBe("file");
  });
});

describe("resolveUnderRoot", () => {
  const ROOT = path.resolve(process.cwd(), "storage");

  it("resolves a normal key under the storage root", () => {
    expect(resolveUnderRoot("proj123/1700000000-file.txt")).toBe(
      path.join(ROOT, "proj123", "1700000000-file.txt"),
    );
  });

  it("throws on a traversal key that escapes the root", () => {
    expect(() => resolveUnderRoot("../secrets.txt")).toThrow(/invalid storage key/);
    expect(() => resolveUnderRoot("proj/../../etc/passwd")).toThrow(/invalid storage key/);
  });

  it("throws on an absolute path", () => {
    const abs = path.resolve(path.sep, "tmp", "pwned");
    expect(() => resolveUnderRoot(abs)).toThrow(/invalid storage key/);
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

// Guards the gate itself.
//
// Written after reading block/berd, which has ~989 Rust test attributes and
// executes ~208 on a PR — because its test recipe filters the app library by a
// literal string — and 47 Playwright cases that no workflow invokes at all.
// A suite that exists but never runs is worse than no suite: it manufactures
// confidence and rots in silence, and nothing in a normal test run reports it.
//
// These assertions are cheap and they fail loudly the day that starts happening
// here. They check the SHAPE of the gate, not the code under it.

const ROOT = process.cwd();
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));

const IGNORED = new Set(["node_modules", ".next", ".git", ".vercel", "storage", "backups", "prisma"]);

function testFilesOnDisk(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (IGNORED.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) testFilesOnDisk(full, found);
    else if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry)) found.push(path.relative(ROOT, full).replace(/\\/g, "/"));
  }
  return found;
}

describe("the gate runs everything it should", () => {
  it("every test file on disk sits where the runner looks", () => {
    const files = testFilesOnDisk(ROOT);
    // Vitest runs with no config here, so its default include is
    // **/*.{test,spec}.?(c|m)[jt]s?(x) from the project root. Anything under
    // src/ is therefore collected. A test file parked outside src/ — a tests/
    // directory, an e2e/ folder — would still be collected today, but it is
    // the first step toward berd's shape, so pin the convention now.
    const stray = files.filter((f) => !f.startsWith("src/"));
    expect(stray, `test files outside src/ — confirm the runner collects them: ${stray.join(", ")}`).toEqual([]);
    // Sanity: if this ever hits zero the glob above has broken, and every
    // other assertion in this file would pass vacuously.
    expect(files.length).toBeGreaterThan(10);
  });

  it("the test script runs the whole suite, unfiltered", () => {
    const test = String(pkg.scripts.test ?? "");
    expect(test).toContain("vitest");
    // berd's exact failure: `just tauri-test` narrows to one string and 79% of
    // the suite silently stops running. -t/--testNamePattern, a path argument,
    // or a project filter would do the same here.
    for (const flag of ["-t ", "--testNamePattern", "--project", "--shard"]) {
      expect(test, `npm test must not filter the suite (found ${flag})`).not.toContain(flag);
    }
    expect(test.trim()).toBe("vitest run");
  });

  it("check runs typecheck, lint and tests — and CI runs check", () => {
    const check = String(pkg.scripts.check ?? "");
    for (const part of ["typecheck", "lint", "test"]) {
      expect(check, `npm run check must include ${part}`).toContain(part);
    }
    // The pre-push hook and CI must invoke the SAME command, or a green push
    // and a green CI run stop meaning the same thing.
    const workflow = readFileSync(path.join(ROOT, ".github", "workflows", "check.yml"), "utf8");
    expect(workflow).toContain("npm run check");
    expect(pkg["simple-git-hooks"]?.["pre-push"]).toBe("npm run check");
  });

  it("every GitHub Action is pinned to a commit, not a moving tag", () => {
    const dir = path.join(ROOT, ".github", "workflows");
    const refs: string[] = [];
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))) {
      const body = readFileSync(path.join(dir, f), "utf8");
      for (const m of body.matchAll(/uses:\s*([^\s#]+)/g)) refs.push(`${f}: ${m[1]}`);
    }
    expect(refs.length).toBeGreaterThan(0);
    // A tag is a branch the publisher can repoint, so "it passed CI" says
    // nothing about which code ran. A 40-char hex sha cannot move.
    const unpinned = refs.filter((r) => !/@[0-9a-f]{40}$/.test(r));
    expect(unpinned, `pin these to a full commit sha: ${unpinned.join(", ")}`).toEqual([]);
  });

  it("declares one Node version, in one place, consistently", () => {
    expect(pkg.engines?.node).toBeTruthy();
    const nvmrc = readFileSync(path.join(ROOT, ".nvmrc"), "utf8").trim();
    const major = String(pkg.engines.node).replace(/[^\d]/g, "").slice(0, 2);
    expect(nvmrc).toBe(major);
    const workflow = readFileSync(path.join(ROOT, ".github", "workflows", "check.yml"), "utf8");
    expect(workflow).toContain(`node-version: ${major}`);
  });
});

import { describe, it, expect } from "vitest";
import { validateSkillName, toSkillMarkdown } from "./skills";

describe("validateSkillName", () => {
  it("accepts kebab-case and normalizes case and padding", () => {
    expect(validateSkillName("run-tests")).toBe("run-tests");
    expect(validateSkillName("  Deploy-Check  ")).toBe("deploy-check");
    expect(validateSkillName("e2e")).toBe("e2e");
  });

  it("rejects anything that would break a folder name or slash command", () => {
    for (const bad of ["Run Tests", "run_tests", "-lead", "trail-", "double--hyphen", "", "../escape"]) {
      expect(() => validateSkillName(bad)).toThrow(/kebab-case/);
    }
    expect(() => validateSkillName("a".repeat(61))).toThrow(/60 characters/);
  });
});

describe("toSkillMarkdown", () => {
  it("emits frontmatter Claude Code can parse, then the body", () => {
    const md = toSkillMarkdown({ name: "run-tests", description: "How to run the suite", body: "# Steps\n\nnpm test" });
    expect(md.startsWith("---\nname: run-tests\n")).toBe(true);
    expect(md).toContain('description: "How to run the suite"');
    expect(md.trimEnd().endsWith("npm test")).toBe(true);
  });

  it("quotes and escapes descriptions that would break the YAML", () => {
    // A raw colon or quote in unquoted YAML silently breaks the whole file.
    const md = toSkillMarkdown({
      name: "deploy",
      description: 'Use when: the "prod" deploy fails\nacross lines',
      body: "x",
    });
    expect(md).toContain('description: "Use when: the \\"prod\\" deploy fails across lines"');
    expect(md.split("---")[1]).not.toContain("\n\n");
  });
});

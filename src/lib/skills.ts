// Per-project skills: the working conventions a project expects its agents to
// follow. Two ways to consume one, and the first is why this exists:
//   1. IN-SESSION over MCP (list_skills / get_skill) — no install, works the
//      moment an agent connects. The session-start briefing lists them, so an
//      agent knows the project's conventions before it does anything.
//   2. DOWNLOADED as a SKILL.md into ~/.claude/skills/<name>/ for people who
//      want the slash-command. Never written by the server — see the
//      no-auto-write rule in the connect kit.

export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_SKILL_BODY = 100_000;

export function validateSkillName(name: string): string {
  const n = name.trim().toLowerCase();
  if (!SKILL_NAME_RE.test(n)) {
    throw new Error("skill name must be kebab-case (letters, digits, single hyphens), e.g. run-tests");
  }
  if (n.length > 60) throw new Error("skill name must be 60 characters or fewer");
  return n;
}

// A skill as Claude Code expects it on disk: YAML frontmatter then markdown.
export function toSkillMarkdown(skill: { name: string; description: string; body: string }): string {
  // Frontmatter is YAML, so a description containing a colon or quote has to be
  // quoted and escaped or the file silently fails to parse.
  const desc = `"${skill.description.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ")}"`;
  return `---\nname: ${skill.name}\ndescription: ${desc}\n---\n\n${skill.body.trim()}\n`;
}

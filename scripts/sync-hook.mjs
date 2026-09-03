// Install or remove a post-commit hook that keeps this repo's code mirror
// current without anyone remembering to run a sync.
//
//   node scripts/sync-hook.mjs install [projectName] [vaultUrl]
//   node scripts/sync-hook.mjs uninstall
//   node scripts/sync-hook.mjs status
//
// Three properties this hook must have, because a previous post-commit hook on
// another project destroyed a day's work:
//
//   1. It CANNOT fail a commit. The hook always exits 0. If the vault is off --
//      which is the normal state for a solo user most of the day -- the commit
//      completes and the sync is simply skipped.
//   2. It CANNOT overwrite mirror-only work. sync-repo refuses any path whose
//      mirrored content is absent from git history, and reports it instead.
//      That protection is what makes automating this safe now.
//   3. It runs detached, so committing never waits on the network.
//
// Nothing is destructive: uninstall removes only a hook this script wrote.
import { existsSync, readFileSync, writeFileSync, unlinkSync, chmodSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const MARKER = "# openvault-sync-hook";
const [cmd = "status", projectName = "OpenVault", vaultUrl = "http://localhost:6900"] = process.argv.slice(2);

const gitDir = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--git-dir"], { encoding: "utf8" }).trim();
  } catch {
    console.error("not a git repository");
    process.exit(1);
  }
})();
const hookPath = path.join(gitDir, "hooks", "post-commit");

const body = `#!/bin/sh
${MARKER}
# Keeps the OpenVault code mirror level with HEAD. Never blocks or fails a
# commit: the vault is usually not running, and that is fine.
LOG="$(git rev-parse --git-dir)/openvault-sync.log"
(
  npx tsx scripts/sync-repo.ts . ${JSON.stringify(projectName)} ${JSON.stringify(vaultUrl)} >"$LOG" 2>&1 || true
) &
exit 0
`;

const mine = () => existsSync(hookPath) && readFileSync(hookPath, "utf8").includes(MARKER);

if (cmd === "install") {
  if (existsSync(hookPath) && !mine()) {
    console.error(`refusing to overwrite an existing post-commit hook at ${hookPath}`);
    console.error("move it aside, or add this line to it yourself:");
    console.error(`  npx tsx scripts/sync-repo.ts . ${projectName} ${vaultUrl} &`);
    process.exit(1);
  }
  mkdirSync(path.dirname(hookPath), { recursive: true });
  writeFileSync(hookPath, body, { mode: 0o755 });
  try { chmodSync(hookPath, 0o755); } catch {}
  console.log(`installed ${hookPath}`);
  console.log(`  project : ${projectName}`);
  console.log(`  vault   : ${vaultUrl}`);
  console.log(`  log     : ${path.join(gitDir, "openvault-sync.log")}`);
} else if (cmd === "uninstall") {
  if (!existsSync(hookPath)) console.log("no post-commit hook to remove");
  else if (!mine()) console.error(`post-commit hook at ${hookPath} was not written by this script — leaving it alone`);
  else { unlinkSync(hookPath); console.log(`removed ${hookPath}`); }
} else {
  console.log(mine() ? `installed at ${hookPath}` : existsSync(hookPath) ? "a post-commit hook exists, but not ours" : "not installed");
}

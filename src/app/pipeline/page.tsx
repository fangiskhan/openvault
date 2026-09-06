import Link from "next/link";
import PipelineScene from "@/components/PipelineScene";

// /pipeline — how work moves through OpenVault, as a diagram you can watch.
//
// PipelineScene is a Client Component, so Next code-splits three.js into this
// route's client bundle and the vault itself never pays for it. Imported
// plainly rather than via next/dynamic: `ssr: false` is only permitted INSIDE
// a Client Component (node_modules/next/dist/docs/01-app/02-guides/
// lazy-loading.md), and it is unnecessary here anyway — every WebGL call lives
// in useEffect, which does not run during server rendering.
//
// Everything below the canvas is plain HTML, so the page still says what it
// means with WebGL unavailable.

export const metadata = {
  title: "OpenVault — how it works",
  description: "One agent's loop, and two agents on one project without a human relaying between them.",
};

const LANES = [
  {
    name: "CONTRIBUTOR",
    colour: "var(--spx-lime)",
    body: "Reads the project's state and current source, says what it is about to touch, and proposes changes it cannot push itself.",
  },
  {
    name: "THE VAULT",
    colour: "var(--spx-cyan)",
    body: "Holds decisions, status, the code mirror and the review queue. It never writes to git — that is what keeps it safe to share.",
  },
  {
    name: "OWNER",
    colour: "var(--spx-magenta)",
    body: "Meets the queue at session start, reviews what is waiting, applies what is approved in its own checkout, and pushes.",
  },
];

const STEPS = [
  ["1", "You prompt an agent", "“Add retries to the API client.” Nothing else is set up — the agent is cold and has never seen this project."],
  ["2", "It briefs itself", "get_briefing returns status, open risks, the team's skills, and any proposals waiting. Zero tokens spent asking you."],
  ["3", "It reads the real code", "get_code_map and read_code serve the mirror, pinned to one commit. No clone, no repo access."],
  ["4", "It announces the work", "announce_work returns anyone already editing those paths — a collision surfaces before it happens, not after."],
  ["5", "It proposes, never pushes", "suggest_change carries content-anchored edits plus a required reason. Each anchor must occur exactly once, so a stale proposal is refused at filing."],
  ["6", "The owner reviews", "The proposal appears in their briefing, their attention list and their inbox. Approving hands them the result — it does not touch git."],
  ["7", "They apply and push", "In their own checkout, on their own machine. Nothing lands that a human did not run."],
  ["8", "CI mirrors it back", "The vault follows the commit, the suggestion closes itself, and the reason survives as a linked note."],
];

export default function PipelinePage() {
  return (
    <main className="pipe-page spx-page">
      <header className="pipe-head">
        <h1>OPENVAULT</h1>
        <p className="pipe-kicker">how one prompt becomes reviewed code — and how two agents share a project without a human relay</p>
        <Link href="/" className="pipe-back">
          ← back to the vault
        </Link>
      </header>

      <PipelineScene />

      <section className="pipe-lanes">
        {LANES.map((l) => (
          <article key={l.name} className="pipe-lane" style={{ borderTopColor: l.colour }}>
            <h2>{l.name}</h2>
            <p>{l.body}</p>
          </article>
        ))}
      </section>

      <section className="pipe-steps">
        <h2 className="pipe-h2">THE LOOP</h2>
        <ol>
          {STEPS.map(([n, title, body]) => (
            <li key={n}>
              <span className="pipe-num">{n}</span>
              <div>
                <strong>{title}</strong>
                <p>{body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="pipe-rule">
        <h2 className="pipe-h2">THE RULE UNDERNEATH</h2>
        <p>
          The vault never writes to git. An agent proposes; a human disposes. That single constraint is why it is safe to let someone
          else&apos;s agent — with no repository access at all — work on your code.
        </p>
      </section>
    </main>
  );
}

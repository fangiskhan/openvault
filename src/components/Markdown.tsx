"use client";

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

type Props = {
  body: string;
  resolve: (title: string) => boolean;
  onWikilink: (title: string) => void;
};

// Render markdown with Obsidian-style [[wikilinks]]. We rewrite wikilinks into
// links with a custom `wikilink:` scheme, then intercept those in the link
// renderer so clicks navigate/create instead of opening a URL. react-markdown
// escapes HTML by default, so this stays XSS-safe.
export default function Markdown({ body, resolve, onWikilink }: Props) {
  const pre = body.replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_m, target: string, alias?: string) =>
      `[${(alias ?? target).trim()}](wikilink:${encodeURIComponent(target.trim())})`,
  );

  const components: Components = {
    a({ href, children, ...props }) {
      if (typeof href === "string" && href.startsWith("wikilink:")) {
        const title = decodeURIComponent(href.slice("wikilink:".length));
        const exists = resolve(title);
        return (
          <button
            type="button"
            className={`wikilink${exists ? "" : " unresolved"}`}
            title={exists ? `Open “${title}”` : `Create “${title}”`}
            onClick={(e) => {
              e.preventDefault();
              onWikilink(title);
            }}
          >
            {children}
          </button>
        );
      }
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
          {children}
        </a>
      );
    },
  };

  return (
    <div className="prose">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {pre}
      </ReactMarkdown>
    </div>
  );
}

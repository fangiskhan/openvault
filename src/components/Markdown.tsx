"use client";

import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
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
//
// NOTE: react-markdown's default URL sanitizer strips any scheme outside its
// safe list (http/https/mailto/...), so it would blank out `wikilink:` hrefs
// before our renderer sees them — turning every wikilink into a dead
// <a href=""> that opens a blank tab. We pass a urlTransform that lets the
// `wikilink:` scheme through and defers everything else to the default (so
// javascript: and other unsafe URLs are still neutralized).
const urlTransform = (url: string) =>
  url.startsWith("wikilink:") ? url : defaultUrlTransform(url);
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
      <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={urlTransform} components={components}>
        {pre}
      </ReactMarkdown>
    </div>
  );
}

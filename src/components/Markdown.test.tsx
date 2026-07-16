import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "./Markdown";

// Regression: react-markdown's default URL sanitizer used to blank out our
// `wikilink:` scheme, so every [[wikilink]] rendered as a dead <a href="">
// (which opened a blank tab on click) instead of the intended <button>.
const render = (body: string, resolve: (title: string) => boolean = () => true) =>
  renderToStaticMarkup(<Markdown body={body} resolve={resolve} onWikilink={() => {}} />);

describe("Markdown wikilinks", () => {
  it("renders a [[wikilink]] as a wikilink button, not an anchor", () => {
    const html = render("See [[Roadmap]] for details.");
    expect(html).toContain('class="wikilink"');
    expect(html).toContain("<button");
    expect(html).toContain("Roadmap");
    // The old bug: a dead anchor with an empty href.
    expect(html).not.toContain('<a href=""');
    expect(html).not.toContain("wikilink:"); // scheme must not leak into output
  });

  it("marks an unresolved target with the unresolved class", () => {
    const html = render("[[Missing]]", () => false);
    expect(html).toContain("wikilink unresolved");
  });

  it("supports [[Target|alias]] display text", () => {
    const html = render("[[Roadmap|the plan]]");
    expect(html).toContain(">the plan</button>"); // alias is the visible label
    expect(html).toContain("Roadmap"); // target still drives the tooltip / nav
  });

  it("still renders normal external links as new-tab anchors", () => {
    const html = render("[docs](https://example.com)");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
  });

  it("still neutralizes unsafe javascript: links", () => {
    const html = render("[x](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
  });
});

import { markdownToHtml } from "satteri";
import { describe, expect, test } from "vitest";
import { leadingH1IsTitle, markdownLinksToPages, titleFromH1 } from "./pages";

const decision = new URL("content/docs/decisions/0001-x.md", import.meta.url);

function render(source: string): string {
  return markdownToHtml(source, {
    fileURL: decision,
    mdastPlugins: [leadingH1IsTitle, markdownLinksToPages],
  }).html;
}

describe("titleFromH1", () => {
  test("takes the title from the first line", () => {
    expect(titleFromH1("# 0002. Add a `type/docs` label\n\nBody")).toBe(
      "0002. Add a type/docs label",
    );
  });

  test("skips frontmatter", () => {
    expect(titleFromH1("---\nsidebar: {}\n---\n# Title\n")).toBe("Title");
  });

  test("finds no title when the page doesn't open with an H1", () => {
    expect(titleFromH1("Intro\n\n# Later heading\n")).toBeUndefined();
    expect(titleFromH1("## Section\n")).toBeUndefined();
  });
});

describe("rendering", () => {
  test("drops the leading H1 and keeps later ones", () => {
    const html = render("# Title\n\nText\n\n# Part two\n");
    expect(html).not.toContain(">Title<");
    expect(html).toContain("Part two");
  });

  test("turns links to Markdown files into page routes", () => {
    const html = render(
      "[a](0007-bun-runtime.md) [b](../plan/milestones/M0-foundations.md#risks) [c][ref]\n\n[ref]: ../README.md\n",
    );
    expect(html).toContain('href="/decisions/0007-bun-runtime/"');
    expect(html).toContain('href="/plan/milestones/m0-foundations/#risks"');
    expect(html).toContain('href="/"');
  });

  test("leaves web links, anchors and links outside the docs alone", () => {
    const html = render(
      "[a](https://example.com/x.md) [b](#context) [c](../../../README.md)\n",
    );
    expect(html).toContain('href="https://example.com/x.md"');
    expect(html).toContain('href="#context"');
    expect(html).toContain('href="../../../README.md"');
  });
});

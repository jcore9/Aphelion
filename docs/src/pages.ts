import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { slug } from "github-slugger";
import { defineMdastPlugin } from "satteri";

const contentRoot = fileURLToPath(new URL("content/docs", import.meta.url));

function pageRoute(entry: string): string {
  const path = entry.replace(/\.md$/, "").replace(/(^|\/)(README|index)$/, "");
  if (path === "") return "/";
  return `/${path
    .split("/")
    .map((segment) => slug(segment))
    .join("/")}/`;
}

export function titleFromH1(source: string): string | undefined {
  return /^(?:---\n[\s\S]*?\n---\n)?\s*# (.+)/
    .exec(source)?.[1]
    ?.replaceAll("`", "")
    .trim();
}

function siteUrl(url: string, fileURL: URL | undefined): string | undefined {
  const [path = "", hash] = url.split("#", 2);
  if (
    !fileURL ||
    !path.endsWith(".md") ||
    /^([a-z][a-z\d+.-]*:|\/)/i.test(path)
  )
    return undefined;
  const target = resolve(dirname(fileURLToPath(fileURL)), decodeURI(path));
  const entry = relative(contentRoot, target);
  if (entry.startsWith("..")) return undefined;
  return pageRoute(entry) + (hash === undefined ? "" : `#${hash}`);
}

export const leadingH1IsTitle = defineMdastPlugin({
  name: "aphelion-leading-h1-is-title",
  before(root, ctx) {
    const first = root.children[0];
    if (first?.type === "heading" && first.depth === 1) ctx.removeNode(first);
  },
});

export const markdownLinksToPages = defineMdastPlugin({
  name: "aphelion-markdown-links-to-pages",
  link(node, ctx) {
    const url = siteUrl(node.url, ctx.fileURL);
    if (url) ctx.setField(node, "url", url);
  },
  definition(node, ctx) {
    const url = siteUrl(node.url, ctx.fileURL);
    if (url) ctx.setField(node, "url", url);
  },
});

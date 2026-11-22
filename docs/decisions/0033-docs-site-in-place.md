# 0033. The docs site reads the Markdown files where they are, and takes each page title from its first heading

- Status: Accepted (approved by merging #122 on 2026-11-22)
- Date: 2026-11-21
- Proposed by: orchestrator, in the M0-16 docs site PR ([#7](https://github.com/jcore9/Aphelion/issues/7))
- Answers: how M0-16 builds `docs/` into a Starlight site without moving files

## Context

M0-16 builds `docs/` into a Starlight site, checked in CI with a link check. Three facts constrain how.

- More than 100 issue bodies link to `https://github.com/jcore9/Aphelion/blob/dev/docs/...` paths. The M0 plan's risks table says M0-16 keeps them resolving. Moving the files breaks those links unless every issue body is edited in the same PR.
- Starlight reads pages from `src/content/docs/`. The link checker, `starlight-links-validator`, works out each page's URL from its path under `src/content/docs/`.
- Starlight needs a `title` for every page. Every file in `docs/` opens with a `# Title` line and has no frontmatter. Records written in that format are still arriving, such as 0025 and 0026.

## Options

Where the site reads the files. Each option was built on 2026-11-21 with Astro 7.4.13, Starlight 0.43.1 and `starlight-links-validator` 0.27.0, on Bun 1.4.5.

| | Result |
| --- | --- |
| Move the files into `docs/src/content/docs/` | Not built. Breaks every issue link to `docs/...`. |
| Astro's `glob` loader with `base: "."` in `docs/` | The site builds, with the right URLs. The link checker reports 151 invalid links in 21 files when every link is valid, because it can't match a page outside `src/content/docs/` to its URL. |
| The same loader, checked by `linkinator` 8.1.0 over the built HTML instead | Reports `/favicon.svg` as a 404. One run that skipped external links didn't finish in 300 s and was stopped. |
| Symbolic links in `docs/src/content/docs/` to `plan`, `decisions` and `spikes`, and `index.md` to `README.md`, read by Starlight's own `docsLoader` | The site builds and every link passes. A link to a missing page and a link to a missing heading each fail the build. |

How each page gets its title:

| | Result |
| --- | --- |
| A `title` field in frontmatter on every file | GitHub shows frontmatter as a table at the top of each file, above the same title. A record in the current format fails the build until someone adds the field. |
| The first line, `# Title` | Every existing file works unchanged, and so does a new record in the current format. |

## Decision

Symbolic links, and the title from the first heading.

- `docs/src/content/docs/` holds only symbolic links. Every Markdown file stays at its path, so GitHub links keep working.
- `docs/src/content.config.ts` wraps Starlight's `docsLoader`. When a page has no `title` in frontmatter, the loader uses the text of its first line if that line is `# Title`. A page that doesn't open with an H1 fails the build with a missing-title error.
- Two plugins for Sätteri, Astro 7's Markdown processor, live in `docs/src/pages.ts`. One drops the opening H1 from the page body, because Starlight prints the title itself. The other rewrites relative links to `.md` files into site URLs, so the same Markdown works on GitHub and on the site. A link to a `README.md` goes to its folder's page.
- `starlight-links-validator` checks every internal link and heading anchor. A relative link to a file outside the docs fails, so a doc links to code with a full GitHub URL. External links aren't checked.
- `bun run docs` builds the site through `bun --bun astro build`, so Astro runs on Bun. A build takes about 2 s. CI runs it as the `docs` check.

The versions are pinned exactly: `astro` 7.4.13, `@astrojs/starlight` 0.43.1, `@astrojs/markdown-satteri` 0.4.10, `satteri` 0.11.7, `starlight-links-validator` 0.27.0 and `github-slugger` 2.0.0.

## Consequences

- A new folder at the top of `docs/` needs a symbolic link in `docs/src/content/docs/`, or its pages don't appear. A generated section, such as the M0-09 protocol spec or the M0-13 API reference, can instead write real files into a new folder under `docs/src/content/docs/`.
- Git checks symbolic links out as small text files on Windows unless `core.symlinks` is on. The site doesn't build there. [Decision 0011](0011-ubuntu-lts.md) targets Linux.
- Page URLs are the file paths in lower case, such as `/plan/milestones/m0-foundations/`. Heading anchors match GitHub's, so `#m0--foundations-v01` works on both.
- The site isn't deployed. Astro skips the sitemap until `site` is set. Hosting is a later decision.
- If `starlight-links-validator` learns to read pages outside `src/content/docs/`, the symbolic links can go, and the loader can point at `docs/` directly.

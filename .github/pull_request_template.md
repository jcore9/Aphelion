<!-- Title: a Conventional Commit, such as `feat(server): ...` or `docs: ...`. It becomes the squash commit on `main`. -->

Closes #

**Plan or decision record:** <!-- A link to the milestone plan section or decision record. -->

## What changed

<!-- What this does for Aphelion, in plain words, then the choices the owner should check. Explain any TypeScript, web or tooling term the first time you use it. -->

## How to review

<!-- The owner is not a TypeScript or web developer. Name the few files that matter, in reading order. For each one, give its path and line range, say in plain words what it does, and say what to check there. Name the tests that show the change works. Then list what is safe to skim, such as `bun.lock` and generated files. -->

1. `path/to/file.ts` lines N to M: what it does, and what to check.

Safe to skim:

## How it was tested

<!-- The tests you added and the commands you ran. Add screenshots for UI changes. -->

- [ ] `bun run lint`, `bun run typecheck`, `bun run test` and `bun run docs` pass.

## Docs touched

<!-- The docs this PR updates, or "None" and why none apply. -->

## Risk

- [ ] None
- [ ] `risk/security`: touches a security-sensitive path, or adds a permission, a secret or a network host. It gets a full line-by-line review.
- [ ] `risk/breaking`: a breaking change, with migration notes for the changelog.

## Plugin authors

<!-- Delete this section if the PR doesn't touch `packages/plugin-sdk` or the plugin host. -->

- [ ] A plugin author can still do this without knowing about users, sockets or Docker.

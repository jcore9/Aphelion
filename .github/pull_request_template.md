<!-- Title: a Conventional Commit, such as `feat(server): ...` or `docs: ...`. It becomes the squash commit on `dev`. -->

Closes #

**Plan or decision record:** <!-- A link to the milestone plan section or decision record. -->

## What changed

<!-- What a reviewer needs to know, and the choices the owner should check. -->

## How it was tested

<!-- The tests you added and the commands you ran. Add screenshots for UI changes. -->

- [ ] `bun run lint`, `bun run typecheck` and `bun run test` pass.

## Docs touched

<!-- The docs this PR updates, or "None" and why none apply. -->

## Risk

- [ ] None
- [ ] `risk/security`: touches a security-sensitive path, or adds a permission, a secret or a network host. It gets a full line-by-line review.
- [ ] `risk/breaking`: a breaking change, with migration notes for the changelog.

## Plugin authors

<!-- Delete this section if the PR doesn't touch `packages/plugin-sdk` or the plugin host. -->

- [ ] A plugin author can still do this without knowing about users, sockets or Docker.

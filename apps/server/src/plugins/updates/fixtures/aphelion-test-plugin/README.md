# Test plugin releases

These are two real releases of the public repository [jcore9-bot/aphelion-test-plugin](https://github.com/jcore9-bot/aphelion-test-plugin). The tests check the update code against them, so the GitHub artifact attestations here are real, not made up for the tests.

The repository was made with `bun run create:plugin <dir> --id aphelion-test-plugin --repository jcore9-bot/aphelion-test-plugin`. Its plugin logs `aphelion-test-plugin <version> started` when it starts. Its generated release workflow built and attested each release.

| Version | Commit | Release workflow run | `aphelion-plugin.tar` SHA-256 | Event permissions |
| --- | --- | --- | --- | --- |
| v1.0.0 | `ee8b3420bd003ad36c7f514533e6250d0ffd24b8` | 45286687224 | `abcec1c8ade7cedf8efd55ba96641c27a6d80a51dbb0e6a0b53a2a25fc42b52b` | `approval.requested` |
| v1.1.0 | `584ecfdaa503b0b88e732ab69e608348f595f7f9` | 45286807559 | `cc4e00ea674b08673542a0fa9eb4e9ce0ce4f51b1eed21fbf44395bf002bfc9d` | `approval.requested`, `bot.status` |

Each folder holds the two release assets, `aphelion-plugin.tar` and `aphelion-plugin.tar.sigstore.json`, and `release.json`, GitHub's answer to `GET /repos/jcore9-bot/aphelion-test-plugin/releases/tags/<tag>`. That answer has the same shape as `releases/latest`.

Each archive holds the entries `./`, `./aphelion-plugin.json` and `./server.mjs`, written by GNU tar in ustar format.

## Refresh them

Only when the release format changes:

1. Regenerate the test repository from the template, then push the tags `v1.0.0` and `v1.1.0` again, so that its release workflow makes new releases.
2. Download each release's two assets with `gh release download <tag> --repo jcore9-bot/aphelion-test-plugin`, and its JSON with `gh api repos/jcore9-bot/aphelion-test-plugin/releases/tags/<tag>`.
3. Update the table above.

The bundles verify against `../../trusted-root.json`. A new trust root still verifies these bundles as long as it keeps the keys they were signed with.

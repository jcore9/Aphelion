# How a release happens

From M1 on, a GitHub Action called release-please works out each version and changelog section from the pull request titles on `main` ([decision 0061](../decisions/0061-release-please.md)). The owner still approves every release, as a pull request. The tags follow [decision 0003](../decisions/0003-release-versioning.md).

## During a milestone

Each merge into `main` runs [`.github/workflows/release.yml`](https://github.com/jcore9/Aphelion/blob/main/.github/workflows/release.yml). It keeps one pull request open, titled like `chore(main): release 0.1.0-alpha.2`, on the branch `release-please--branches--main`. That pull request:

- sets the version in `apps/server/package.json`, `apps/server/src/version.ts` and `.release-please-manifest.json`
- adds a section for the new version at the top of `CHANGELOG.md`, built from the `feat:`, `fix:`, `perf:`, `docs:` and `revert:` titles merged since the last tag

It updates itself after every merge. Leave it open until the milestone ends.

GitHub doesn't start CI for a pull request that a workflow opened or updated, so its `lint`, `typecheck` and `test` checks wait at "Expected — Waiting for status to be reported". That's normal while the milestone runs.

## At the end of a milestone

1. Check the release pull request. The version should match the milestone's row in decision 0003. Each changelog line should say what changed in words a user follows, and breaking changes should be called out. To change a line, edit the description of the merged pull request it came from, and add the new title between two marker lines, `BEGIN_COMMIT_OVERRIDE` and `END_COMMIT_OVERRIDE`. release-please uses that title instead the next time it runs.
2. Close the release pull request and reopen it. Reopening starts CI as you, so the required checks run on its latest commit.
3. Once they pass, approve and merge the release pull request. release-please then tags that commit, for example `v0.1.0-alpha.2`, and creates the GitHub release, marked as a pre-release.

## Versions that need an override

release-please counts up the pre-release number: `0.1.0-alpha.2`, `alpha.3`, `alpha.4`. The other steps in decision 0003's table need a one-time override:

| Milestone | Version | Set `release-as` to |
| --- | --- | --- |
| M4 | `0.1.0` | `"0.1.0"`, and also set `"prerelease": false` |
| M5 | `1.0.0-beta.1` | `"1.0.0-beta.1"` |
| M8 | `1.0.0` | `"1.0.0"` |

Before that milestone's release, a pull request adds the line to the `"."` package in [`release-please-config.json`](https://github.com/jcore9/Aphelion/blob/main/release-please-config.json):

```json
"packages": {
  ".": {
    "release-as": "0.1.0",
    "extra-files": [...]
  }
}
```

The release pull request then proposes that version. release-please marks every release below `1.0.0` as a GitHub pre-release while `"prerelease"` is `true`, so M4 also sets it to `false`. M5 sets it back to `true` and `"prerelease-type"` to `"beta"`. After the release, the next pull request removes the line, or every later release pull request would propose the same version again.

## Before the first run

The owner does these once.

Do them in this order. The alpha.1 merge into `main` starts the release workflow before the tag exists. While the setting in step 2 is still off, that first run can't open a pull request, so it fails without harm.

1. Right after the alpha.1 release merges into `main`, tag that merge commit as `v0.1.0-alpha.1`, so release-please knows where M1 starts:

   ```sh
   sha=$(gh api repos/jcore9/Aphelion/commits/main --jq .sha)
   gh api repos/jcore9/Aphelion/commits/$sha --jq .commit.message
   awk '/^## v0.1.0-alpha.1/{f=1;next} /^## /{f=0} f' CHANGELOG.md > /tmp/notes.md
   gh release create v0.1.0-alpha.1 --repo jcore9/Aphelion --target "$sha" \
     --prerelease --title v0.1.0-alpha.1 --notes-file /tmp/notes.md
   ```

   The second command prints the commit's message. It should be the merge of the alpha.1 release pull request. If it isn't, find the right commit before you run the last command.

2. Turn on Settings → Actions → General → Workflow permissions → **Allow GitHub Actions to create and approve pull requests**. release-please opens its pull request with the workflow's own key, `GITHUB_TOKEN`, and GitHub allows that only with this setting.
3. Run the release workflow again: `gh workflow run release.yml --repo jcore9/Aphelion --ref main`. It now starts from the tag. If a release pull request that lists every old commit is open anyway, close it and run the workflow again.

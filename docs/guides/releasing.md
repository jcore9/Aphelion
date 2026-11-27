# How a release happens

From M1 on, a GitHub Action called release-please works out each version and its release notes from the pull request titles on `main` ([decision 0061](../decisions/0061-release-please.md)). The owner still approves every release, as a pull request. The owner merges the release pull request, and `jcore9-bot` never does ([decision 0062](../decisions/0062-one-main-branch.md)). The tags follow [decision 0003](../decisions/0003-release-versioning.md).

## During a milestone

Each merge into `main` runs [`.github/workflows/release.yml`](https://github.com/jcore9/Aphelion/blob/main/.github/workflows/release.yml). It keeps one pull request open, titled like `chore(main): release 0.1.0-alpha.2`, on the branch `release-please--branches--main`. That pull request:

- sets the version in `apps/server/package.json`, `apps/server/src/version.ts` and `.release-please-manifest.json`
- writes the release notes in its own description, built from the `feat:`, `fix:`, `perf:`, `docs:` and `revert:` titles merged since the last tag

Merging it copies those notes into the GitHub release. The repo has no `CHANGELOG.md`. The [releases page](https://github.com/jcore9/Aphelion/releases) is the changelog.

It updates itself after every merge. Leave it open until the milestone ends.

GitHub doesn't run CI by itself for a pull request that a workflow opened or updated. Its five required checks wait, or GitHub asks someone to approve the run. That's normal while the milestone runs.

## At the end of a milestone

1. Check the release pull request. The version should match the milestone's row in decision 0003. Each line of the release notes should say what changed in words a user follows, and breaking changes should be called out. To change a line, edit the description of the merged pull request it came from. Add the new title between two marker lines, `BEGIN_COMMIT_OVERRIDE` and `END_COMMIT_OVERRIDE`. The next time release-please runs, it uses that title instead.
2. Start CI on its latest commit. If GitHub shows **Approve and run workflows** on the pull request, click it. Otherwise close the pull request and reopen it, which starts CI as you.
3. Once they pass, approve the release pull request and squash-merge it. The pull request needs your approval, because `.release-please-manifest.json` is an owner path. release-please then tags that commit, for example `v0.1.0-alpha.2`, and creates the GitHub release, marked as a pre-release.

## What a release publishes

When the release pull request merges, the same `Release` workflow also builds the Aphelion image (the packaged server that the installer runs) and publishes it. It builds one copy for x86-64 computers and one for arm64 computers, each on a computer of that type, and joins them into a single image named `ghcr.io/jcore9/aphelion`. The image gets two tags: its version, for example `0.1.0-alpha.2`, and `latest`. The steps are in [`.github/workflows/image.yml`](https://github.com/jcore9/Aphelion/blob/main/.github/workflows/image.yml).

The release also gets a small file called `aphelion-image.sha256`. It holds one line, the image's **digest**, which is a fingerprint of the exact image:

```
ghcr.io/jcore9/aphelion@sha256:<64 letters and digits>
```

When a host can download the published image, `aphelion upgrade` and the installer pull it by that line and refuse any image whose fingerprint differs ([decision 0063](../decisions/0063-m1-planning-answers.md)).

**Optional: making the package public.** GitHub creates the `aphelion` package as private, and the workflow can't change that. Making it public is optional. While the package stays private, hosts that aren't signed in to `ghcr.io` can't download the image, so `aphelion upgrade` and the installer build the image on the server instead. If you later want hosts to download the published image without signing in, open the package from **Packages** on your GitHub profile, go to **Package settings**, and set the visibility to **Public**. GitHub doesn't let you make a public package private again.

To check it yourself:

1. Open the release on the [releases page](https://github.com/jcore9/Aphelion/releases) and look at the `aphelion-image.sha256` file under **Assets**. The summary of the `Release` run in the Actions tab prints the same line.
2. Run `docker buildx imagetools inspect ghcr.io/jcore9/aphelion:<version>` on a computer with Docker (while the package is private, sign in to `ghcr.io` with `docker login ghcr.io` first). Compare the `sha256:` value on its `Digest:` line with the `sha256:` value in the file. They must be the same. The file's line also has `ghcr.io/jcore9/aphelion@` in front, which the `Digest:` line doesn't.

The same workflow also runs on any pull request that changes `deploy/Dockerfile` or the workflow itself. There it builds both images and stops. It publishes nothing, so a pull request can't change a released image.

## Versions that need an override

release-please counts up the pre-release number, for example `0.1.0-alpha.2`, `alpha.3`, `alpha.4`. The other steps in decision 0003's table need a one-time override.

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

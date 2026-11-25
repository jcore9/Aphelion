# 0057. The server updates a plugin from its GitHub releases, proven genuine by an artifact attestation, on the owner's approval and with no restart

- Status: Accepted (approved by merging #175 on 2026-11-24)
- Date: 2026-11-23
- Decided by: project owner, for the choices marked "owner" in the options
- Proposed by: the M0-13f PR ([#159](https://github.com/jcore9/Aphelion/issues/159))
- Answers: [#159](https://github.com/jcore9/Aphelion/issues/159), how a plugin gets a new version without root, a restart or blind trust
- Amends: [0051](0051-plugin-dev-kit.md), because the control socket is now always on and carries a `restart` request for the harness only. [0042](0042-plugin-server-and-client-parts.md), because plugin files now live in a volume that the server's user owns. Plugins still can't write it.

## Context

Plugins will ship new versions more often than Aphelion does. Today an update needs root on the host to change the plugin folder, a new approval, and a restart of the whole service.

[#159](https://github.com/jcore9/Aphelion/issues/159) asks for four things. The server checks a plugin's GitHub releases and shows what a new version changes. It installs the version only when the owner approves. It switches the running plugin with no server restart. `rollback` goes back one version. A plugin still can't change its own code.

Some terms, because the choices below depend on them:

- A **hash** is a short fingerprint of some bytes. One changed byte gives a different fingerprint. This record uses SHA-256.
- A **tar** file bundles many files into one.
- An **attestation** is a signed statement from GitHub that says "this file was built by this workflow in this repository at this tag". GitHub makes it during the build, with no key for the plugin author to keep.
- **Sigstore** is the public service that signs and records such statements. The statement and its proof travel in a small file called a **bundle**.
- A **trust root** is the file that lists the keys Sigstore uses today. A statement counts only when it was signed with a key on the list.
- A **socket** here is a file that two programs on one machine use to talk. Only the right user can open it.

[Decision 0042](0042-plugin-server-and-client-parts.md) says that plugin code can't write an installed package folder. [Decision 0051](0051-plugin-dev-kit.md) says that an ordinary deployment opens no socket, and a contract test checks that. This record changes the second rule.

The owner made ten choices on 2026-11-23, and they aren't reopened here:

1. Every update waits for `--approve <token>`. Automatic updates come later, off by default.
2. Updates come from the GitHub releases of the repository the manifest names.
3. The genuineness check is a GitHub artifact attestation.
4. An always-on control socket, mode `0600`, harness only, restarts a plugin from its approved record. Dev mode's `reload` works only in dev mode.
5. Existing approvals aren't migrated. Each installed plugin needs one more approval.
6. Dev mode approves a folder by its permissions only.
7. `update` takes the latest full release and refuses one that's equal or older. Only `rollback` goes back.
8. The server keeps the current version and the one before it, and deletes older ones.
9. Downloads come only from GitHub hosts, with size limits.
10. The public repository `jcore9-bot/aphelion-test-plugin` provides two real attested releases as test fixtures.

Two design runs sketched this. The first has the update module run in the process that calls it, and the socket only restarts a plugin. The second has the server do everything from preview to switch. This record keeps the first, with parts of the second: grants that follow the running version, a check on the automatic-restart path, plain tar, and the exact identity rule.

## Options

### A. How a release is proven genuine

| Option | Picked by | For | Against |
| --- | --- | --- | --- |
| Artifact attestation (Sigstore) | owner | Nothing for the author to keep safe. Proves which repository, workflow and tag built the file. Verified offline in 15 ms. | Needs the trust root and a verifier library. |
| A signing key pinned in the manifest | | No extra library. | The author must guard a private key forever. A stolen or lost key breaks every update. |
| A checksum only | | Simplest. | Proves the file arrived intact, not who made it. Whoever can change the release can change the checksum. |

### B. Where the update code runs

| Option | Picked by | For | Against |
| --- | --- | --- | --- |
| In the process that calls it, plus a restart request over the socket | proposed | The always-on socket carries one small job. #65's HTTP API can call the same functions inside the server later. | The CLI needs read and write access to the plugin volume. It has that, since it runs as `harness`. |
| Everything inside the server, over the socket | proposed, rejected | The CLI becomes a thin client. | The always-on door grows to carry downloads, preview and apply. An update then needs the running server. |

### C. The control socket

| Option | Picked by | For | Against |
| --- | --- | --- | --- |
| One always-on socket, harness only | owner | The CLI can restart a plugin with no server restart. One socket means one cleanup path and one contract-test check. | Reverses 0051's "no socket" rule. The door is small: `restart` takes only a plugin ID. |
| No socket, with polling | | Nothing new to open. | The server would have to notice a change on a timer, so a switch isn't prompt and its result can't be reported back. |

### D. Where the trust root comes from

| Option | Picked by | For | Against |
| --- | --- | --- | --- |
| Shipped in the server, refreshed by a script | proposed | Verification is offline. No new trust path. The script prints the key IDs that changed, and a person reviews the change. | A release signed after a key rotation fails until Aphelion is upgraded. The root changed 3 times in 2025. |
| Fetched at run time | | Never stale. | An unsigned download would be a weaker trust path than the file in the image. |
| A TUF client | | The proper way to fetch and verify the root. | A lot of code for a rare event. |

### E. Release format

| Option | Picked by | For | Against |
| --- | --- | --- | --- |
| A plain ustar tar plus the attestation bundle, both as release assets | proposed | No decompression, so no decompression bomb. A small reader of about 100 lines checks every header before anything is written. | About 184 KB for the test plugin, a little larger than a gzip. |
| A gzip-compressed tar | proposed, rejected | Smaller. | Needs a limit on the unpacked size, and a bomb check. |
| GitHub's attestation API | proposed, rejected | No bundle asset to upload. | Measured: it now returns a link to a bundle on `tmaproduction.blob.core.windows.net`, compressed with snappy, plus a second attestation signed by GitHub's own Sigstore instance, which needs another trust root. |

The release workflow uploads the bundle next to the archive, so the server fetches both from GitHub and nowhere else.

### F. Where plugin files live

| Option | Picked by | For | Against |
| --- | --- | --- | --- |
| A named volume `plugin-files`, owned by `harness` | proposed | The server can write a new version with no root. `aphelion-plugins` can read it but not write it, so the runner's checks pass unchanged. | The operator copies existing plugins into the volume once. |
| The root-owned host folder, as today | | Nothing to migrate. | Every update needs root on the host, which is the problem this record exists to solve. |

### G. What an approval covers

| Option | Picked by | For | Against |
| --- | --- | --- | --- |
| The permission list plus a hash of every file, per version | proposed | A new version number alone needs no new permission review, and new permissions always do. The approval proves which code was approved. | The host hashes the files at each start. |
| The manifest text, as today | | Nothing to change. | Covers neither the code beside the manifest nor a permission-only comparison between versions. |

### H. A new version that fails to start

| Option | Picked by | For | Against |
| --- | --- | --- | --- |
| Go back to the old version automatically | proposed | The plugin keeps working, and the report names both states. | The old version is stopped briefly. |
| Leave it stopped | | Simplest. | The owner has to notice and run `rollback`. |

### I. How tests reach a fake GitHub

| Option | Picked by | For | Against |
| --- | --- | --- | --- |
| A test-only URL setting, with verification unchanged | proposed | The fake can serve only bytes that carry a real attestation for the right repository and tag. The check that matters never changes. | One environment variable that production must ignore, and the guide says so. |
| A test trust root | proposed, rejected | Tests could sign their own releases. | A second trust root in the code. A bug could trust it in production. |

## Decision

Pick the options marked "owner" or "proposed" above. The rules that follow are in plain words.

### What a release looks like

- The tag is `v<version>`, and `<version>` equals the manifest's `version`. The release is a full release (not a draft, not a pre-release), and the version is strict semver with no pre-release part or build metadata. The workflow publishes pre-release versions as pre-releases and refuses versions with build metadata such as `+build`.
- The archive asset is `aphelion-plugin.tar`. It holds the plugin's `dist/` folder at its root, and a leading `./` is accepted. The bundle asset is `aphelion-plugin.tar.sigstore.json`.
- The manifest gets an optional `repository` field, `owner/name`, with no URL form. The plugin API version goes from 0.2.1 to 0.2.2, because the field only adds to the API.

### How a release is checked

- The verifier is `@sigstore/verify` 4.1.3 with `@sigstore/bundle` 5.0.1 and `@sigstore/protobuf-specs` 0.5.2, pinned exactly. It needs one transparency-log entry and one certificate-log entry. The issuer must be `https://token.actions.githubusercontent.com`.
- **The exact identity rule.** The signer's identity must equal `https://github.com/<repository>/.github/workflows/release.yml@refs/tags/v<version>`. The `<owner>/<name>` part is compared without regard to case, and every other part exactly.
- **The checks the library doesn't do.** The library does not compare the signed statement with the file you downloaded. So the server checks, on the verified statement, that its type is `https://in-toto.io/Statement/v1`, that its predicate type is `https://slsa.dev/provenance/v1`, that it has exactly one subject named `aphelion-plugin.tar`, and that the subject's SHA-256 equals the hash of the downloaded bytes. All of this runs before the archive is opened.
- After unpacking, the archive's manifest must name the installed plugin's ID, the tag's version, and the installed repository, compared without regard to case. Its API range must include the host's.
- The trust root is `updates/trusted-root.json`, copied from `sigstore/root-signing`. It is never fetched at run time. A refusal for an unknown key says that the release is signed with a key this Aphelion doesn't know, or isn't genuine, and to upgrade Aphelion.

### Downloads and limits

- Only `api.github.com`, `github.com`, `objects.githubusercontent.com` and `release-assets.githubusercontent.com`, over `https` on the default port, with no credentials. Redirects are followed by hand, at most 3 hops, each checked. Each request times out after 30 seconds.
- Limits, counted on the streamed bytes: release JSON 1 MiB, bundle 1 MiB, archive 32 MiB.
- Unpacking accepts only files and folders. It refuses links, devices, PAX headers and GNU long names, unsafe names, duplicate paths, and archives over 1000 entries, 16 MiB per file, 64 MiB in total or 32 path segments. The ustar format itself keeps each part of a name to at most 155 bytes. It ignores the archive's modes and owners, and writes into a new staging folder with files opened exclusively.
- A rate limit is reported with its reset time. Redirect query strings are never logged.
- **Test-only setting.** `APHELION_GITHUB_API`, for example `http://127.0.0.1:8099`, makes that one origin the API base and the only allowed host, and allows plain `http` for it. Verification doesn't change. There is no test trust root and no switch that turns verification off.

### Where files live, and what an approval covers

- The `plugin-files` volume is mounted at `/opt/aphelion/plugins`, owned by `harness:harness` with mode `0755`. Each release version is `<id>@<version>/`. The install guide copies a folder install to `<id>/`, so a release at `<id>/<version>/` would land inside that folder and change its files hash. A plugin ID can't hold `@`. Unpacking happens in `.staging/` on the same volume, so the final move is one atomic `rename`. Every install, update and rollback holds a kernel lock on `plugin-files.lock` in the state folder. The kernel releases the lock when the command ends.
- An approval records the plugin's ID, version, folder, sorted permissions, and one hash of every file in the folder. Hidden files count, and a symbolic link is refused.
- The update token covers the current and proposed approvals. It includes both versions, folders, file hashes, and permission lists. It uses a separate label from the install token. The database transaction checks the current approval again before replacing it.
- Each run checks grants against the approval it started with. The version and folder must still match. The files hash must also match outside dev mode.
- Both `host.start` and the host's own automatic-restart path check that the manifest's ID, version, and canonical folder still have an approval. They also check that the files hash to the approved value outside dev mode and that the manifest's permissions are within the granted ones. A mismatch refuses the start, with a plain reason in the log.
- **Existing approvals need one more approval.** Migration 0006 carries no data over.
- **Dev mode approves by permissions only**, because every edit changes the file hashes. Only the canonical dev folder gets this treatment.
- `plugin install <absolute folder>` keeps working in place. A folder install whose manifest names `repository` can later update to a release. The folder version then becomes the previous version, and a folder path is never deleted.

### How an update runs

- `prepareUpdate` reads the latest release, downloads, verifies, unpacks, hashes, and works out the permission changes and the approval token. `applyUpdate` compares the token, moves the staging folder into place, records the version and grants in one database transaction, restarts the plugin, and cleans up. The CLI holds the lock across both, and runs `prepareUpdate` on both calls, so nothing is cached between the preview and `--approve`.
- The control socket is `<state-dir>/plugin-control.sock`, mode `0600`. `restart` takes only a plugin ID, reads the approved record, and waits up to 15 seconds for the plugin to settle. Once the run reaches `running`, the server watches it for 10 more seconds, as the owner chose. If the run leaves that state, the reply reports the new state. The client waits up to 90 seconds for a reply.
- During boot, the socket opens before plugins start. Boot and restart requests take turns, and boot reads the current approval for each plugin just before it starts it. `reload` is refused with "dev mode is off" unless the server runs with `--plugin-dev`.
- **Rollback is one step and needs no new approval.** The previous version was approved already. `rollback` refuses when there is no previous version, switches back and restarts. If the earlier version fails to start or stops during the watch, Aphelion restores both approval pointers and restarts the version it left.
- When a new version with a server part fails to start or stops during the watch, the update command goes back automatically, tries to restart the old version, and reports both states. If the old version also fails to start, Aphelion keeps both releases and their approvals.
- When the server isn't running, the files and the record are kept. The CLI says that the plugin starts on the new version when the server starts, and exits with 0.
- If an update recorded the new version but stopped before restarting it, `aphelion plugin restart <id>` starts the approved version.
- Pruning drops old version records first. It deletes only managed release folders with no remaining approval. Both update and rollback remove abandoned staging files and unreferenced release folders before proceeding. Cleanup keeps approved folders and their contents, including paths that reach them through a symbolic link.

### What the spike measured

On this machine, with Bun 1.4.5, the verifier checked a real GitHub attestation in 15 ms. A wrong repository failed with `PolicyError UNTRUSTED_SIGNER_ERROR`. A changed payload failed with `VerificationError`. The four packages are about 1 MB. Both fixture releases from `jcore9-bot/aphelion-test-plugin` (`v1.0.0` and `v1.1.0`) verify with the shipped trust root. `v1.1.0` adds one event permission and logs a different start line. The fixtures, with a README that says where they came from, are in `apps/server/src/plugins/updates/fixtures/`.

## Consequences

- **Plugin authors** name the repository in the manifest (`create:plugin --repository owner/name` writes it), keep the generated `release.yml`, commit `bun.lock`, and push a `v` tag. The workflow checks the tag against the manifest, packs, attests and publishes the two assets. Every `uses:` in it is pinned to a full commit SHA.
- **Operators** copy existing plugins into the `plugin-files` volume once, approve each installed plugin once more after upgrading, and use `aphelion plugin update <id>` and `rollback`. To refresh the trust root, run `bun scripts/update-trusted-root.ts`, review the printed key IDs, and open a PR.
- The contract test's write probe now expects `EACCES` for a plugin, where it expected `EROFS`. The socket check now expects a `0600` socket owned by `harness` in a plain run, with `reload` refused.
- **Left for [#65](https://github.com/jcore9/Aphelion/issues/65):** the update button in the app, which calls the same functions inside the server. Automatic updates also come later. Today every update shows the preview and waits for `--approve`.
- Out of scope: private repositories and GitHub tokens, a first install straight from a release, [#161](https://github.com/jcore9/Aphelion/issues/161), [#168](https://github.com/jcore9/Aphelion/issues/168), and how client parts are delivered.
- The unauthenticated GitHub API allows 60 requests an hour. That is the limit until a token option exists, and the server reports the reset time when it hits it.

Revisit this record when:

- The trust root goes stale, because Sigstore rotated its keys faster than Aphelion ships.
- Sigstore changes the bundle format.
- GitHub adds signed release assets natively, which could replace the bundle asset.

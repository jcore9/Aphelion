# Apply the rulesets

A ruleset is a set of GitHub rules for a branch or a tag. `main.json` protects the `main` branch. `tags.json` protects the release tags, which are the names that start with `v`, such as `v0.1.0-alpha.2`. [Branch protection](../../docs/branch-protection.md) explains each rule and [decision 0062](../../docs/decisions/0062-one-main-branch.md) gives the reasons.

Applying them needs the Admin role, so the owner runs these steps. Run the commands from a checkout of this repository, signed in to `gh` as `jcore9`. Do the steps in order. Until you finish them, nobody merges.

## Move to one `main` branch

1. Replace the `main` ruleset with the new `main.json`. The command finds the ruleset by name and replaces it, so it isn't created a second time:

   ```sh
   id=$(gh api repos/jcore9/Aphelion/rulesets --jq '.[] | select(.name == "main") | .id')
   gh api --method PUT "repos/jcore9/Aphelion/rulesets/$id" --input .github/rulesets/main.json
   ```

   In the web UI, go to **Settings** > **Rules** > **Rulesets**, open `main`, and change it to match the file.

2. Create the tag ruleset:

   ```sh
   gh api --method POST repos/jcore9/Aphelion/rulesets --input .github/rulesets/tags.json
   ```

   In the web UI, click **New ruleset** > **Import a ruleset** on the same page, and choose `tags.json`.

3. Delete the `dev` ruleset:

   ```sh
   id=$(gh api repos/jcore9/Aphelion/rulesets --jq '.[] | select(.name == "dev") | .id')
   gh api --method DELETE "repos/jcore9/Aphelion/rulesets/$id"
   ```

4. Delete the `dev` branch. This works only after step 3, because the `dev` ruleset blocks deleting it:

   ```sh
   gh api --method DELETE repos/jcore9/Aphelion/git/refs/heads/dev
   ```

   In the web UI, go to **Code** > **Branches** and delete `dev`.

5. Allow only squash merges, which turn a pull request into one commit. Delete a branch after its pull request merges, and give the squash commit the pull request's title:

   ```sh
   gh api --method PATCH repos/jcore9/Aphelion \
   	-F allow_squash_merge=true \
   	-F allow_merge_commit=false \
   	-F allow_rebase_merge=false \
   	-F delete_branch_on_merge=true \
   	-f squash_merge_commit_title=PR_TITLE \
   	-f squash_merge_commit_message=COMMIT_MESSAGES
   ```

   In the web UI, go to **Settings** > **General** > **Pull Requests**.

6. Keep the Actions token read-only, and let workflows approve pull requests:

   ```sh
   gh api --method PUT repos/jcore9/Aphelion/actions/permissions/workflow \
   	-f default_workflow_permissions=read \
   	-F can_approve_pull_request_reviews=true
   ```

   In the web UI, go to **Settings** > **Actions** > **General** > **Workflow permissions**.

   [Decision 0061](../../docs/decisions/0061-release-please.md) needs this setting, because release-please opens its release pull request from a workflow. You already turned it on. It is safe because the merge rule asks for a code owner, and a workflow's approval isn't a code owner's.

7. Check the result. The first command lists four rules for `main`. The second shows the tag ruleset. The third prints `[]` when GitHub reads every line of `CODEOWNERS`:

   ```sh
   gh api repos/jcore9/Aphelion/rules/branches/main --jq '.[].type'
   gh api repos/jcore9/Aphelion/rulesets --jq '.[] | {name, target}'
   gh api 'repos/jcore9/Aphelion/codeowners/errors?ref=main' --jq '.errors'
   ```

   The four rules are `deletion`, `non_fast_forward`, `pull_request` and `required_status_checks`.

## Update a ruleset

To apply a changed file, replace the existing ruleset by its ID. Don't create it a second time.

```sh
id=$(gh api repos/jcore9/Aphelion/rulesets --jq '.[] | select(.name == "main") | .id')
gh api --method PUT "repos/jcore9/Aphelion/rulesets/$id" --input .github/rulesets/main.json
```

For the tag ruleset, use `release tags` and `tags.json`.

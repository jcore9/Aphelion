# Apply the rulesets

`dev.json` and `main.json` protect the `dev` and `main` branches. [Branch protection](../../docs/branch-protection.md) explains each rule. Applying them needs the Admin role, so the owner runs these steps. Run the commands from a checkout of this repository, signed in to `gh` as `jcore9`.

## Change the repository settings

1. Allow squash merges for `dev` and merge commits for `main`, and turn off rebase merges. Delete head branches after a merge. Give squash and merge commits the pull request's title:

   ```sh
   gh api --method PATCH repos/jcore9/Aphelion \
   	-F allow_squash_merge=true \
   	-F allow_merge_commit=true \
   	-F allow_rebase_merge=false \
   	-F delete_branch_on_merge=true \
   	-f squash_merge_commit_title=PR_TITLE \
   	-f squash_merge_commit_message=COMMIT_MESSAGES \
   	-f merge_commit_title=PR_TITLE \
   	-f merge_commit_message=PR_BODY
   ```

   The deletion rule in each ruleset stops the automatic delete from removing `dev` after a release pull request merges.

2. Keep the Actions token read-only, and stop workflows from approving pull requests:

   ```sh
   gh api --method PUT repos/jcore9/Aphelion/actions/permissions/workflow \
   	-f default_workflow_permissions=read \
   	-F can_approve_pull_request_reviews=false
   ```

In the web UI, the first step is **Settings** > **General** > **Pull Requests**. The second step is **Settings** > **Actions** > **General** > **Workflow permissions**.

## Create the rulesets

1. Create both rulesets:

   ```sh
   gh api --method POST repos/jcore9/Aphelion/rulesets --input .github/rulesets/dev.json
   gh api --method POST repos/jcore9/Aphelion/rulesets --input .github/rulesets/main.json
   ```

   In the web UI, go to **Settings** > **Rules** > **Rulesets**. Click **New ruleset** > **Import a ruleset**, and choose the file.

2. Check that each branch has four rules: `deletion`, `non_fast_forward`, `pull_request` and `required_status_checks`:

   ```sh
   gh api repos/jcore9/Aphelion/rules/branches/dev --jq '.[].type'
   gh api repos/jcore9/Aphelion/rules/branches/main --jq '.[].type'
   ```

3. After `CODEOWNERS` reaches `dev`, check that GitHub reads every line. The command prints `[]` when it does:

   ```sh
   gh api 'repos/jcore9/Aphelion/codeowners/errors?ref=dev' --jq '.errors'
   ```

## Update a ruleset

To apply a changed file, replace the existing ruleset by its ID. Don't create it a second time.

```sh
id=$(gh api repos/jcore9/Aphelion/rulesets --jq '.[] | select(.name == "dev") | .id')
gh api --method PUT "repos/jcore9/Aphelion/rulesets/$id" --input .github/rulesets/dev.json
```

For `main`, use `main` in both places.

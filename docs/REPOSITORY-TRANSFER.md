# Planned organization move

Founder choice, 2026-11-12: use a GitHub organization so both founders can have repository admin access. Proposed organization name selected by the founder: **first-press-app**. Intended destination: **first-press-app/first-press**. Collaborator: [TawfiqAbubaker](https://github.com/TawfiqAbubaker). Keep the repository public. This is a plan; no organization creation, ownership transfer or invitation has been performed.

## Before the transfer

1. Confirm `first-press-app` is available and create the organization under the founder's control. GitHub Free is sufficient for the current public-repository model; do not choose a paid plan without a separate need. Confirm who should be organization Owner separately from repository Admin: they are different permissions.
2. Finish/merge the current development PR, verify CI and note the main commit. Preserve a local git clone and the planning/issue mapping. The target must not already contain `first-press` or a conflicting fork.
3. Review the receiving organization's default repository permissions and Actions settings. Arrange repository Admin for `ayadebbagh` and `TawfiqAbubaker`; do not assume that transferring ownership assigns both roles. GitHub's default adds the transferring owner as a collaborator, whose access must be checked.
4. Install/authorize the GitHub connection for the receiving organization and ensure the new repository is selected after transfer. Organization administration/invitation/transfer is not available through the current connector tools, so these account steps require the founder's GitHub settings session.

## Move and verify

Transfer the existing repository through Repository Settings → General → Transfer ownership, targeting `first-press-app`, keeping the name `first-press`. Transfer this repository, rather than creating a replacement and pushing only the code: issue numbers, PR history, commits, stars and planning context should remain attached.

After the transfer, grant/verify repository Admin for both named users. Send the collaborator invitation only as part of the chosen move; confirm acceptance before reporting access as established. If organization-level co-ownership is desired, make that separate explicit decision.

Update `origin`, planning repository constants/maps, canonical links, workflow assumptions and connector repository access. Replace `ayadebbagh/first-press` references with the destination where appropriate, preserving historical source URLs. Run the planning validator and check dry-run sync targets before any writes. Confirm open issues, labels, milestones, PRs and assignments survived; personal-account issue assignees who are not organization members can be cleared on transfer.

Run the full CI and container HTTP checks from the new repository. Check Actions permissions, required checks/rules, artifacts, integration access and any secrets/webhooks/deploy keys. A transfer preserves many repository settings/secrets, but the receiving organization's policies still apply. Create/reconnect the requested GitHub Project under the organization when its Projects permissions are available. Confirm both people can manage settings and merge PRs; repository visibility remains public.

GitHub redirects old repository URLs and git remotes after a transfer, but local remotes should still be updated. Do not create a new repository at the old path: that can remove the redirects. No deployment/domain transfer is involved because production hosting has not been selected or enabled.

## Completion evidence

Record the destination URL and main SHA; accepted collaborator access; effective admin role for both users; a green CI run at the new owner; successful connector read/write scope; preserved issue/milestone counts and planning validation. Until those checks pass, this task is planned, not completed.

Sources: [personal repository permissions](https://docs.github.com/en/enterprise-cloud%40latest/repositories/managing-your-repositorys-settings-and-features/repository-access-and-collaboration/permission-levels-for-a-personal-account-repository), [organization roles](https://docs.github.com/en/enterprise-cloud%40latest/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization), [repository transfers](https://docs.github.com/en/repositories/creating-and-managing-repositories/transferring-a-repository), checked 2026-11-12.

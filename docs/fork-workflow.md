# Maintained Cody fork

This fork keeps nphil/Cody as its upstream source and carries local Cody, OMPweb,
and Windows integrations on top. An upstream pull request is optional; it is
not the source of truth for the version used here.

## Remotes and branches

- `origin` is `Jackthegr8at/Cody`, the only normal push destination.
- `upstream` is `nphil/Cody`, fetch-only in this checkout. Do not push to it.
- `codex/maintained` is the maintained integration branch. It is separate from
  PR #20's branch, so routine work does not silently expand that pull request.
- Fork `main` is the public release branch. Its Docker and Windows workflows
  publish to this fork's GHCR package and release channel; pushing it can
  publish artifacts. Promote only a verified `codex/maintained` commit and
  inspect both workflow results after promotion.

## Working and upstream updates

1. Commit and test local changes on `codex/maintained`. Push that branch to
   `origin`. Promote it to fork `main` only after release checks pass, and
   deploy only an explicitly verified commit.
2. Fetch `upstream`. Record and review each unseen upstream/OMPweb commit in
   an integration ledger before advancing the integration baseline.
3. Integrate new upstream commits in a separate temporary branch or worktree
   based on `codex/maintained`. Resolve overlaps without replacing native
   Windows, taskbar, notifications, models, pagination, provider account
   management, or other maintained behavior wholesale.
4. Run typecheck, focused tests, lint, build, and relevant smoke checks. Report
   failures or skipped checks; only merge the tested result into
   `codex/maintained` when acceptable for deployment.
5. Open small, focused upstream PRs from separate fork branches when useful.
   Update PR #20 only when its exact scope needs correction or review.

Never force-push the maintained branch or rewrite history that others may have
used. Keep a rollback commit for deployments.

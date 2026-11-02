---
name: steward
description: Repository conventions for driving Soldock pull requests to a mergeable state (CI failures, review comments, merge conflicts). Read before acting on PR events in this repo.
---

# Driving Soldock PRs

- **The CI gate is `pnpm verify`.** Reproduce failures locally with the same command before pushing a fix.
- **Conflicts:** merge the base branch into the PR branch. Don't rebase branches that
  others may have checked out. A branch you created yourself in this session may be rebased if you prefer.
- **`pnpm-lock.yaml` conflicts:** take the base branch's version, then run `pnpm install` to regenerate it. Never hand-edit it.
- **Review comments that change scope** (new features, a design change): propose a follow-up GitHub issue instead of widening the PR.
- **Comments from the implementation reviewer agent** are advisory. Address blocking
  findings, and answer each non-blocking one in one line.
- **Never merge PRs.** The maintainer merges.

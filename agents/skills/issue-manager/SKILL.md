---
name: issue-manager
description: Coordinate PostgreSQL Workbench GitHub issues, pull requests, and authorized releases. Audit real backlog and PR state, verify publication prerequisites and results, and realign the local checkout after an authorized merge. Do not use for product implementation or GitHub workflow redesign.
---

# Issue Manager

Use GitHub MCP by default for issues, labels, pull requests, reviews, checks,
and merges. Use local Git for checkout state. Use `gh` with targeted elevation
only when MCP lacks the required operation or reliable verification. Technical
access never authorizes a mutation.

Do not implement product features, redesign GitHub workflows, or invent labels,
governance, milestones, or process.

## Issues

- Inspect open issues and existing labels.
- Identify missing, inconsistent, duplicate, or obsolete classification; report
  the concrete proposed requalification.
- Apply issue edits or labels only for the explicitly approved issue or batch.
- Preserve the repository issue workflow: technical labels plus the documented
  capability labels; do not invent labels.

## Pull requests

- Inspect the real PR state: draft status, conflicts, review decision and
  threads, CI/check conclusions, mergeability, and visible blockers.
- Report whether it is ready to merge.
- Merge only after explicit authorization for that PR or batch.
- After an authorized merge, fetch and fast-forward the current checkout to
  `origin/main`. Confirm the merged PR, remote `main` HEAD, local `main`, and a
  clean worktree.

## Publication

- Follow the relevant `RELEASING.md` checklist for the authorized release.
- **Extension release:** `extension-v<version>` must exactly match
  `vscode-extension/package.json`. Confirm README and publication information
  remain aligned, run the extension release gates, package and inspect the
  VSIX, and perform the required real VS Code and PostgreSQL verification.
  Confirm the protected `marketplace` environment and `VSCE_PAT` before the
  first extension release tag.
- **DAP release:** `dap-v<version>` must exactly match
  `packages/dap/package.json`. Follow the DAP release validation,
  package, and npm publication path; do not apply the extension VSIX,
  Marketplace, or manual VS Code smoke requirements to it.
- Never create or push either release tag without explicit authorization.
- After an authorized publication, verify the remote tag or ref, the actual
  Actions and release or npm publication result, and CI. Report green,
  running/queued, or failing; name a failing check and its impact.

For each mutation, state the exact target and act only within the approved
scope.

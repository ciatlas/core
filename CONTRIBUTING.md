# Contributing

Node.js 22 or later and pnpm (pinned in `package.json`; `corepack enable` picks it up). The commands are in the
[README](README.md#development).

## How a change reaches flowpact and simul-ci

1. A pull request here, squash-merged once **CI passed** and **Conventional PR title** pass and a code owner approves.
2. Every push to `main` updates the release pull request (release-please, as `ciatlas-release-bot`). Merging it tags
   `vX.Y.Z` and creates an immutable GitHub release. Nothing is published to a registry.
3. Renovate opens a `fix(deps): update @ciatlas/core` pull request in each consumer, which runs its whole suite against
   the new version.

To change core and a consumer together, link your checkout from the consumer: `pnpm link ../core`. It writes a
`link:` override into the consumer's `pnpm-workspace.yaml`; remove it before you commit (the consumer's tests refuse it).

## Rules for this package

- **No install scripts** (`prepare`, `install`, …): pnpm refuses a git dependency that has to run one. `test/manifest.test.ts`
  checks it.
- **Source only:** consumers compile `src/` with their own TypeScript settings, so keep `tsconfig.json` at least as strict
  as theirs.
- **No product logic:** rules, configuration, reports and product names belong to the tools built on core.

## Commit messages

Pull request titles follow [Conventional Commits](https://www.conventionalcommits.org) (`type(scope): summary`): the
title is the squashed commit, and release-please reads only those. `feat` → minor, `fix`/`perf` → patch; before 1.0 a
breaking change (`!`) bumps the minor version.

# @ciatlas/core

The GitHub Actions workflow model behind [flowpact](https://github.com/ciatlas/flowpact) and simul-ci: it reads the
workflows and local actions of a repository and models what they declare and how data flows between them.
- **Parse:** workflow and action YAML into an IR with source locations, validated against GitHub's schema
  (`@actions/workflow-parser`).
- **Resolve:** callers → reusable workflows → composite actions, `needs`, inputs, secrets, outputs, env and the
  checked-out workspace, across files.
- **Evaluate:** GitHub's expression language, partially, with unknowns kept unknown; matrix expansion exactly as GitHub
  expands it; check-run names as GitHub reports them.
- **Query:** the data-flow graph, symbol locations and traces.

It has no rules, no configuration and no output formats: the tools built on it do.

## Using it

The package is not on npm. Depend on a release tag:

```json
{ "dependencies": { "@ciatlas/core": "github:ciatlas/core#v0.4.0" } }
```

It ships its TypeScript source and no build: bundle it with the `source` export condition (esbuild/tsup
`conditions: ['source']`, TypeScript `customConditions: ["source"]`). Versions follow Semantic Versioning: a breaking
change is a major release, also before 1.0 (up to 0.4.0 one could come in a minor release).

### In the browser

The package's `browser` export condition (or `@ciatlas/core/browser`) serves an entry without `node:fs`, `node:path`
or git: the same parser, graph and queries, and a `loadProject` that takes the files it is given through
`memoryFileSystem`. Bundlers that target the browser pick the condition on their own; `overlayFileSystem` layers
unsaved edits over it.

### Remote sources

`resolveRemoteCommit` and `fetchRemoteSourceAt` read another repository's reusable workflow or action over the GitHub
REST API, at a commit, with retries. The `fetch`, the token and a cache (`memoryRemoteCache`, or your own) are passed
in, so they run in Node and in the browser; the token is sent only to its API. `@ciatlas/core/remote-fetch` serves them
and the remote references alone, without the parser.

`remoteRefOfUses` names the remote reference a `uses:` names, resolved where it is written: inside another repository's
unit, a `./` or same-repository `uses:` names that repository's file at its commit, never yours. `remoteRefsOf` lists
a project's remote references, and `fetchRemoteClosure` reads every remote source a project reaches, at the commits
your pins give, breadth first.

## Development

```sh
pnpm install
pnpm test          # unit and property tests
pnpm coverage
pnpm typecheck
pnpm lint          # Biome
pnpm exec fallow   # code health (fallow.tools); CI runs `fallow audit` on pull requests
```

See [CONTRIBUTING.md](CONTRIBUTING.md). MIT licensed.

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
{ "dependencies": { "@ciatlas/core": "github:ciatlas/core#v0.1.0" } }
```

It ships its TypeScript source and no build: bundle it with the `source` export condition (esbuild/tsup
`conditions: ['source']`, TypeScript `customConditions: ["source"]`). Before 1.0, a minor version may break.

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

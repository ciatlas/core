# Changelog

## [2.6.0](https://github.com/ciatlas/core/compare/v2.5.0...v2.6.0) (2026-10-30)


### Features

* **remote:** fetch remote sources through an injected fetch ([#60](https://github.com/ciatlas/core/issues/60)) ([06aff6f](https://github.com/ciatlas/core/commit/06aff6f8c6160062166ca6ff0d42a0b41d6e9700))
* **remote:** read GitHub's actions.lock pins ([#58](https://github.com/ciatlas/core/issues/58)) ([6234279](https://github.com/ciatlas/core/commit/62342794ee5152bf68f0e0c1fc38d72c607dbb8d))
* **remote:** the remote references inside a unit ([#62](https://github.com/ciatlas/core/issues/62)) ([9736c1b](https://github.com/ciatlas/core/commit/9736c1b44ff516ef2ad3cb06644ed5610afb8b08))


### Bug Fixes

* **project:** parse each remote unit as its own repository's ([#59](https://github.com/ciatlas/core/issues/59)) ([efd42f0](https://github.com/ciatlas/core/commit/efd42f0b877919c6aa8120c44d9515e89959cf16))

## [2.5.0](https://github.com/ciatlas/core/compare/v2.4.0...v2.5.0) (2026-10-18)

### Features

- **project:** a browser entry without node:fs, node:path or git ([#50](https://github.com/ciatlas/core/issues/50)) ([7fdfdbd](https://github.com/ciatlas/core/commit/7fdfdbd290acb158873c94b134fde187f8d5e89b))

## [2.4.0](https://github.com/ciatlas/core/compare/v2.3.0...v2.4.0) (2026-10-18)

### Features

- **expressions:** evaluate option for the runtime functions ([#48](https://github.com/ciatlas/core/issues/48)) ([edd0f04](https://github.com/ciatlas/core/commit/edd0f04f35c789f99dde36e6da44ed9730382eca))

## [2.3.0](https://github.com/ciatlas/core/compare/v2.2.0...v2.3.0) (2026-10-17)

### Features

- **locate:** a step and a step's own env as symbols ([#46](https://github.com/ciatlas/core/issues/46)) ([2875c47](https://github.com/ciatlas/core/commit/2875c4705e9c662c473fc7fc1c58a41c8cdebef9))

## [2.2.0](https://github.com/ciatlas/core/compare/v2.1.0...v2.2.0) (2026-10-14)

### Features

- **graph:** external units for the interfaces of remote workflows and actions ([#44](https://github.com/ciatlas/core/issues/44)) ([d6e2908](https://github.com/ciatlas/core/commit/d6e2908e47f7ad7d3d35f9316b047392ee1609c2))

## [2.1.0](https://github.com/ciatlas/core/compare/v2.0.0...v2.1.0) (2026-10-14)

### Features

- **ir:** read each job's runs-on and environment ([#43](https://github.com/ciatlas/core/issues/43)) ([0a6f2a9](https://github.com/ciatlas/core/commit/0a6f2a92d2e9cc5ebbec89a14efe22643798301f))


### Bug Fixes

- **parse:** read an expression's delimiters within the value only ([#41](https://github.com/ciatlas/core/issues/41)) ([c4fecdf](https://github.com/ciatlas/core/commit/c4fecdf11dd250926b4da3160d33d4258c4590b5))

## [2.0.0](https://github.com/ciatlas/core/compare/v1.0.0...v2.0.0) (2026-10-14)

### ⚠ BREAKING CHANGES

- **graph:** In a workflow, `ProjectIndex.readsOf` of a whole or computed `secrets` reference (`toJSON(secrets)`, `secrets.*`, `secrets[x]`) returns, besides the secrets the workflow declares under `workflow_call`, each secret it reads by name or a caller passes it by name under `secrets:` (one symbol per spelling), `GITHUB_TOKEN`, and each secret that a caller handing it every secret through `secrets: inherit`, directly or through workflows that do, declares, reads by name or is passed by name. `usagesOf` lists the read as a whole usage (`whole: true`) of each of them, so a secret read by name and a named `GITHUB_TOKEN` get more usages, and `nodes` and `edges` gain an `unresolved` node for each secret only a whole read reads and a `flows` edge from each to the site's sink.

### Features

- **graph:** read every secret a workflow holds in a whole secrets read: those it reads by name, those callers pass it, those behind secrets: inherit, and GITHUB_TOKEN ([#39](https://github.com/ciatlas/core/issues/39)) ([f108a23](https://github.com/ciatlas/core/commit/f108a2386afbe0a8eb3a9e59848d193a81f8bb0c))


### Bug Fixes

- **parse:** end an expression where the source ends it, also in a block scalar or a double-quoted scalar with escapes ([#38](https://github.com/ciatlas/core/issues/38)) ([dc9809c](https://github.com/ciatlas/core/commit/dc9809cd3772ecf7e655f379cf363665f6fdd0b9))
- **parse:** locate a reference written after a property that follows a dot and spaces or a line break ([#38](https://github.com/ciatlas/core/issues/38)) ([dc9809c](https://github.com/ciatlas/core/commit/dc9809cd3772ecf7e655f379cf363665f6fdd0b9))
- **trace:** follow secrets: inherit to the spelling the other workflow uses, up and down, and never hand on GITHUB_TOKEN ([#39](https://github.com/ciatlas/core/issues/39)) ([f108a23](https://github.com/ciatlas/core/commit/f108a2386afbe0a8eb3a9e59848d193a81f8bb0c))
- **trace:** name the workflow of a symbol the graph has no node for ([#36](https://github.com/ciatlas/core/issues/36)) ([2c8d903](https://github.com/ciatlas/core/commit/2c8d903514e052938379fabb5cf0352e7486219c))

## [1.0.0](https://github.com/ciatlas/core/compare/v0.4.0...v1.0.0) (2026-10-13)

### ⚠ BREAKING CHANGES

- **graph:** In a workflow that can be dispatched, `usagesOf` now lists a whole or computed read of `github` (`toJSON(github)`, `github[x]`, `github.event[x]`, `toJSON(github.event.inputs)`), and a read (`env.G`, `toJSON(env)`) of a step's own env value that holds one, as a whole usage of each `workflow_dispatch` input. `github.event.inputs.<name>` resolves only to a `workflow_dispatch` input, in any letter case, and `github` in an input's default or a `workflow_call` output's value reads no input. `readsContextDynamically(unit, 'inputs')` no longer counts any `github` read, so it returns false for a unit whose only dynamic reads are `toJSON(github.event)`, `toJSON(github.event.inputs)` or `github.event.inputs[x]`. A rule about the value a caller passes should skip the usages for which the new `usageReadsCallerEvent(index, usage)` is true: in a workflow that can be called, they read the caller's `github` context instead.

### Features

- **trace:** export usageReadsCallerEvent for rules about the value a caller passes ([#34](https://github.com/ciatlas/core/issues/34)) ([f5f4212](https://github.com/ciatlas/core/commit/f5f421270341be3bf6ccc5199e5dd6371bc119c5))


### Bug Fixes

- **graph:** compare context property names in any letter case, as GitHub does ([#34](https://github.com/ciatlas/core/issues/34)) ([f5f4212](https://github.com/ciatlas/core/commit/f5f421270341be3bf6ccc5199e5dd6371bc119c5))
- **graph:** read a whole or computed github as the dispatch inputs it holds, and none where the workflow is only called ([#34](https://github.com/ciatlas/core/issues/34)) ([f5f4212](https://github.com/ciatlas/core/commit/f5f421270341be3bf6ccc5199e5dd6371bc119c5))
- **graph:** resolve github.event.inputs.&lt;name&gt; only to a workflow_dispatch input ([#34](https://github.com/ciatlas/core/issues/34)) ([f5f4212](https://github.com/ciatlas/core/commit/f5f421270341be3bf6ccc5199e5dd6371bc119c5))

## [0.4.0](https://github.com/ciatlas/core/compare/v0.3.0...v0.4.0) (2026-10-13)

### ⚠ BREAKING CHANGES

- **queries:** count a whole secrets read behind secrets: inherit as reading every secret ([#31](https://github.com/ciatlas/core/issues/31))

### Bug Fixes

- **expressions:** locate references after a string literal that spans lines ([#29](https://github.com/ciatlas/core/issues/29)) ([131e48d](https://github.com/ciatlas/core/commit/131e48d53e6b29fbbbb3c1bdf1e14be6f640e9dd))
- **queries:** count a whole secrets read behind secrets: inherit as reading every secret ([#31](https://github.com/ciatlas/core/issues/31)) ([e71e033](https://github.com/ciatlas/core/commit/e71e033d5b12680e64578873f1d2b375fd05f41d))
- **trace:** label an action's output edge 'action output' ([#30](https://github.com/ciatlas/core/issues/30)) ([a7c8895](https://github.com/ciatlas/core/commit/a7c88956ac29623626aea9b1ba60a50bdf68eafa))

## [0.3.0](https://github.com/ciatlas/core/compare/v0.2.0...v0.3.0) (2026-10-13)

### Features

- **graph:** read every member of a whole or computed inputs, matrix, secrets and env ([#19](https://github.com/ciatlas/core/issues/19)) ([ead31af](https://github.com/ciatlas/core/commit/ead31aff96fba2329be7f4afcfafe22ff8166418))
- **trace:** show an input's default where a caller or step omits it ([#16](https://github.com/ciatlas/core/issues/16)) ([773da54](https://github.com/ciatlas/core/commit/773da543006cc935e6f39e512aa59914e560be9a))


### Bug Fixes

- **parse:** locate references outside string literals and block-scalar headers ([#15](https://github.com/ciatlas/core/issues/15)) ([e8cd2fb](https://github.com/ciatlas/core/commit/e8cd2fb3b4423a141d9515d92e62e12ea2bf4034))
- **trace:** read github.event.inputs as the caller's event in a workflow that can be called ([#18](https://github.com/ciatlas/core/issues/18)) ([e59c782](https://github.com/ciatlas/core/commit/e59c782bdf209e2296222a4439621b2f5912f0d7))

## [0.2.0](https://github.com/ciatlas/core/compare/v0.1.0...v0.2.0) (2026-10-13)

### Features

- **trace:** show where a value comes from when the trace ends at a context or a plain value ([#8](https://github.com/ciatlas/core/issues/8)) ([0c26943](https://github.com/ciatlas/core/commit/0c269438f5ac23d2b8e550fa2e3cfeb75ed7d7b0))

## 0.1.0 (2026-10-12)

### Features

- stand alone as @ciatlas/core, used as a git dependency on version tags ([1609abc](https://github.com/ciatlas/core/commit/1609abc00068338d8fc63bafff0ed67bf62ca795))

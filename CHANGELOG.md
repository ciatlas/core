# Changelog

## [1.0.0](https://github.com/ciatlas/core/compare/v0.4.0...v1.0.0) (2026-10-13)


### ⚠ BREAKING CHANGES

* **graph:** In a workflow that can be dispatched, `usagesOf` now lists a whole or computed read of `github` (`toJSON(github)`, `github[x]`, `github.event[x]`, `toJSON(github.event.inputs)`), and a read (`env.G`, `toJSON(env)`) of a step's own env value that holds one, as a whole usage of each `workflow_dispatch` input. `github.event.inputs.<name>` resolves only to a `workflow_dispatch` input, in any letter case, and `github` in an input's default or a `workflow_call` output's value reads no input. `readsContextDynamically(unit, 'inputs')` no longer counts any `github` read, so it returns false for a unit whose only dynamic reads are `toJSON(github.event)`, `toJSON(github.event.inputs)` or `github.event.inputs[x]`. A rule about the value a caller passes should skip the usages for which the new `usageReadsCallerEvent(index, usage)` is true: in a workflow that can be called, they read the caller's `github` context instead.

### Features

* **trace:** export usageReadsCallerEvent for rules about the value a caller passes ([#34](https://github.com/ciatlas/core/issues/34)) ([f5f4212](https://github.com/ciatlas/core/commit/f5f421270341be3bf6ccc5199e5dd6371bc119c5))


### Bug Fixes

* **graph:** compare context property names in any letter case, as GitHub does ([#34](https://github.com/ciatlas/core/issues/34)) ([f5f4212](https://github.com/ciatlas/core/commit/f5f421270341be3bf6ccc5199e5dd6371bc119c5))
* **graph:** read a whole or computed github as the dispatch inputs it holds, and none where the workflow is only called ([#34](https://github.com/ciatlas/core/issues/34)) ([f5f4212](https://github.com/ciatlas/core/commit/f5f421270341be3bf6ccc5199e5dd6371bc119c5))
* **graph:** resolve github.event.inputs.&lt;name&gt; only to a workflow_dispatch input ([#34](https://github.com/ciatlas/core/issues/34)) ([f5f4212](https://github.com/ciatlas/core/commit/f5f421270341be3bf6ccc5199e5dd6371bc119c5))

## [0.4.0](https://github.com/ciatlas/core/compare/v0.3.0...v0.4.0) (2026-10-13)


### ⚠ BREAKING CHANGES

* **queries:** count a whole secrets read behind secrets: inherit as reading every secret ([#31](https://github.com/ciatlas/core/issues/31))

### Bug Fixes

* **expressions:** locate references after a string literal that spans lines ([#29](https://github.com/ciatlas/core/issues/29)) ([131e48d](https://github.com/ciatlas/core/commit/131e48d53e6b29fbbbb3c1bdf1e14be6f640e9dd))
* **queries:** count a whole secrets read behind secrets: inherit as reading every secret ([#31](https://github.com/ciatlas/core/issues/31)) ([e71e033](https://github.com/ciatlas/core/commit/e71e033d5b12680e64578873f1d2b375fd05f41d))
* **trace:** label an action's output edge 'action output' ([#30](https://github.com/ciatlas/core/issues/30)) ([a7c8895](https://github.com/ciatlas/core/commit/a7c88956ac29623626aea9b1ba60a50bdf68eafa))

## [0.3.0](https://github.com/ciatlas/core/compare/v0.2.0...v0.3.0) (2026-10-13)


### Features

* **graph:** read every member of a whole or computed inputs, matrix, secrets and env ([#19](https://github.com/ciatlas/core/issues/19)) ([ead31af](https://github.com/ciatlas/core/commit/ead31aff96fba2329be7f4afcfafe22ff8166418))
* **trace:** show an input's default where a caller or step omits it ([#16](https://github.com/ciatlas/core/issues/16)) ([773da54](https://github.com/ciatlas/core/commit/773da543006cc935e6f39e512aa59914e560be9a))


### Bug Fixes

* **parse:** locate references outside string literals and block-scalar headers ([#15](https://github.com/ciatlas/core/issues/15)) ([e8cd2fb](https://github.com/ciatlas/core/commit/e8cd2fb3b4423a141d9515d92e62e12ea2bf4034))
* **trace:** read github.event.inputs as the caller's event in a workflow that can be called ([#18](https://github.com/ciatlas/core/issues/18)) ([e59c782](https://github.com/ciatlas/core/commit/e59c782bdf209e2296222a4439621b2f5912f0d7))

## [0.2.0](https://github.com/ciatlas/core/compare/v0.1.0...v0.2.0) (2026-10-13)


### Features

* **trace:** show where a value comes from when the trace ends at a context or a plain value ([#8](https://github.com/ciatlas/core/issues/8)) ([0c26943](https://github.com/ciatlas/core/commit/0c269438f5ac23d2b8e550fa2e3cfeb75ed7d7b0))

## 0.1.0 (2026-10-12)


### Features

* stand alone as @ciatlas/core, used as a git dependency on version tags ([1609abc](https://github.com/ciatlas/core/commit/1609abc00068338d8fc63bafff0ed67bf62ca795))

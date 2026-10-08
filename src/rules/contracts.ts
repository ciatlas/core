import type { ContractPlanEntry } from '../contracts';
import type { UnitDecl } from '../ir';
import type { Loc } from '../source';
import { defineRule, type RuleContext, type RuleDefinition } from './types';
import { listNames } from './util';

const fileStart = (file: string): Loc => ({ file, line: 1, column: 1, endLine: 1, endColumn: 1 });

/** Best location in the current workflow/action for a changed contract path such as `inputs.config`. */
function locFor(unit: UnitDecl | undefined, path: string, fallback: Loc): Loc {
  if (!unit) return fallback;
  const [kind, name] = path.split('.');
  if (unit.kind === 'workflow') {
    if (kind === 'inputs' && name) return unit.call?.inputs[name]?.loc ?? unit.call?.loc ?? fallback;
    if (kind === 'dispatchInputs' && name)
      return unit.dispatch?.inputs[name]?.loc ?? unit.dispatch?.loc ?? fallback;
    if (kind === 'secrets' && name) return unit.call?.secrets[name]?.loc ?? unit.call?.loc ?? fallback;
    if (kind === 'outputs' && name) return unit.call?.outputs[name]?.loc ?? unit.call?.loc ?? fallback;
    if (kind === 'calls' && name) return unit.jobs[name]?.uses?.loc ?? unit.jobs[name]?.loc ?? fallback;
    return unit.call?.loc ?? unit.dispatch?.loc ?? fallback;
  }
  if (kind === 'inputs' && name) return unit.inputs[name]?.loc ?? fallback;
  if (kind === 'outputs' && name) return unit.outputs[name]?.loc ?? fallback;
  return fallback;
}

function* entries(
  ctx: RuleContext,
  status: ContractPlanEntry['status'][],
): Generator<{ entry: ContractPlanEntry; unit?: UnitDecl }> {
  for (const entry of ctx.contracts?.entries ?? []) {
    if (!status.includes(entry.status)) continue;
    const unit = entry.unit ? ctx.index.unit(entry.unit) : undefined;
    yield { entry, ...(unit ? { unit } : {}) };
  }
}

const GENERATE =
  'Run `wfc generate` and commit the updated contracts. In CI, the wfc action (check mode) attaches the regenerated contracts and a `git apply`-able patch to the run — see its job summary.';

export const contractMissing = defineRule({
  code: 'WFC801',
  name: 'contract-missing',
  category: 'contracts',
  defaultSeverity: 'error',
  docs: {
    summary: 'A workflow or local action has no contract in `.github/workflow-contracts/` (check mode).',
    why: 'Without a locked contract, changes to its interface and wiring are not visible in review and cannot be checked.',
    fix: GENERATE,
  },
  check(ctx) {
    for (const { entry, unit } of entries(ctx, ['create'])) {
      ctx.report({
        message: `${entry.unit} has no contract (expected ${entry.file})`,
        loc: unit ? fileStart(unit.file) : fileStart(entry.file),
        ...(entry.unit ? { symbol: entry.unit } : {}),
      });
    }
  },
});

export const contractOutdated = defineRule({
  code: 'WFC802',
  name: 'contract-outdated',
  category: 'contracts',
  defaultSeverity: 'error',
  docs: {
    summary:
      'The locked contract no longer matches the workflow — non-breaking changes to its interface or wiring.',
    why:
      'The contract is the reviewed record of what flows in and out. When it drifts silently, the next reviewer compares ' +
      'against stale information.',
    fix: GENERATE,
  },
  check(ctx) {
    for (const { entry, unit } of entries(ctx, ['update'])) {
      if (entry.invalid) continue; // WFC805
      const changes = entry.changes.filter((c) => !c.breaking);
      if (changes.length === 0 && entry.changes.length > 0) continue; // only breaking changes → WFC803
      ctx.report({
        message: `Contract ${entry.file} is outdated: ${
          changes.length
            ? listNames(
                changes.map((c) => c.message),
                4,
              )
            : 'formatting or ordering changed'
        }`,
        loc: unit ? locFor(unit, changes[0]?.path ?? '', fileStart(unit.file)) : fileStart(entry.file),
        related: [{ loc: fileStart(entry.file), message: 'locked contract' }],
        ...(entry.unit ? { symbol: entry.unit } : {}),
      });
    }
  },
});

export const breakingInterfaceChange = defineRule({
  code: 'WFC803',
  name: 'breaking-interface-change',
  category: 'contracts',
  defaultSeverity: 'error',
  docs: {
    summary:
      'A change breaks the locked contract: an input became required, an input/secret/output was removed, or a type changed.',
    why:
      'Callers written against the locked interface will fail (unknown or missing input) or silently read empty outputs. ' +
      'In large pipelines those callers may live in other repositories or rarely-run branches.',
    fix: 'Update every caller first (wfc lists the known consumers), then regenerate the contract. If the change is intended, `wfc generate` records it and the diff makes the break explicit in review.',
    examples: {
      bad: `# contract: input "channel" optional
on:
  workflow_call:
    inputs:
      channel: { type: string, required: true }   # now required`,
      good: `# keep it optional with a default (a required workflow_call input ignores its default),
# or update all callers first, then: wfc generate
      channel: { type: string, required: false, default: stable }`,
    },
  },
  check(ctx) {
    for (const { entry, unit } of entries(ctx, ['update', 'delete'])) {
      if (entry.status === 'delete') continue; // WFC804
      const consumers =
        unit?.kind === 'action'
          ? ctx.index.usersOf(unit.path).map((u) => ({
              loc: u.step.uses?.loc ?? u.step.loc,
              message: `consumer: ${u.unit.path}${u.job ? ` › jobs.${u.job.id}` : ''} › steps.${u.step.id ?? `#${u.step.index + 1}`}`,
            }))
          : ctx.index.callersOf(entry.unit ?? '').map((c) => ({
              loc: c.job.uses?.loc ?? c.job.loc,
              message: `consumer: ${c.caller.path} › jobs.${c.job.id}`,
            }));
      for (const change of entry.changes.filter((c) => c.breaking)) {
        ctx.report({
          message: `Breaking change to ${entry.unit}: ${change.message}`,
          loc: unit ? locFor(unit, change.path, fileStart(unit.file)) : fileStart(entry.file),
          symbol: `${entry.unit}#${change.path}`,
          related: [{ loc: fileStart(entry.file), message: 'locked contract' }, ...consumers.slice(0, 5)],
        });
      }
    }
  },
});

export const orphanContract = defineRule({
  code: 'WFC804',
  name: 'orphan-contract',
  category: 'contracts',
  defaultSeverity: 'error',
  docs: {
    summary: 'A contract file exists for a workflow or action that no longer exists.',
    why:
      'If the workflow was removed or renamed, anything still calling it (including other repositories) breaks — the stale ' +
      'contract is the last record of that interface.',
    fix: 'Confirm nothing depends on the removed workflow, then run `wfc generate` to delete the contract.',
  },
  check(ctx) {
    for (const { entry } of entries(ctx, ['delete'])) {
      if (entry.invalid) continue; // WFC805 — an unreadable file does not say what it describes
      ctx.report({
        message: `Contract ${entry.file} describes ${entry.unit ?? 'a workflow'} which no longer exists`,
        loc: fileStart(entry.file),
        ...(entry.unit ? { symbol: entry.unit } : {}),
      });
    }
  },
});

export const contractInvalid = defineRule({
  code: 'WFC805',
  name: 'contract-invalid',
  category: 'contracts',
  defaultSeverity: 'error',
  docs: {
    summary:
      'A contract file cannot be read (invalid YAML or schema), usually because it was edited by hand or merged badly.',
    why: 'An unreadable contract cannot be compared, so drift and breaking changes go unnoticed.',
    fix: 'Contracts are generated: resolve the merge by running `wfc generate` instead of editing the file.',
  },
  check(ctx) {
    for (const { entry } of entries(ctx, ['update', 'delete'])) {
      if (!entry.invalid) continue;
      ctx.report({
        message: `Contract ${entry.file} is invalid: ${entry.invalid}`,
        loc: fileStart(entry.file),
      });
    }
  },
});

export const contractRules: RuleDefinition[] = [
  contractMissing,
  contractOutdated,
  breakingInterfaceChange,
  orphanContract,
  contractInvalid,
];

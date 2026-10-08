import { type ProjectIndex, sym } from '../graph';
import { type JobDecl, lookup, type StepDecl, type UnitDecl } from '../ir';
import { defineRule, type RuleDefinition } from './types';
import { didYouMean, listNames, quote, readsContextDynamically, refsOf } from './util';

function jobOutputNames(index: ProjectIndex, job: JobDecl): string[] {
  const callee = index.calleeOf(job);
  if (callee) return Object.keys(callee.call?.outputs ?? {});
  return Object.keys(job.outputs);
}

function stepsInScope(unit: UnitDecl, jobId: string | undefined): StepDecl[] {
  if (unit.kind === 'action') return unit.steps;
  return jobId ? (unit.jobs[jobId]?.steps ?? []) : [];
}

export const undefinedOutputRef = defineRule({
  code: 'FP301',
  name: 'undefined-output-ref',
  category: 'outputs',
  defaultSeverity: 'error',
  docs: {
    summary: 'An expression reads an output (`needs.*`, `jobs.*`, `steps.*`) that is never defined.',
    why: 'Undefined outputs evaluate to an empty string. Downstream jobs then run with missing versions, tags or flags.',
    fix: 'Fix the output name, declare the output on the job/workflow/action, or reference the right job or step.',
    examples: {
      bad: `jobs:
  build:
    outputs:
      version: \${{ steps.meta.outputs.version }}
  deploy:
    needs: build
    run: deploy \${{ needs.build.outputs.vesion }}`,
      good: `    run: deploy \${{ needs.build.outputs.version }}`,
    },
  },
  check(ctx) {
    for (const unit of ctx.index.units()) {
      for (const { site, ref } of refsOf(unit)) {
        const [a, b, c] = ref.path;
        if (!a || a === '*' || a === '?') continue;
        if ((ref.context === 'needs' || ref.context === 'jobs') && unit.kind === 'workflow') {
          if (ref.context === 'jobs' && site.field !== 'workflow.output') continue;
          if (b !== 'outputs' || !c || c === '*' || c === '?') continue;
          const job = lookup(unit.jobs, a);
          if (!job) {
            if (ref.context === 'jobs') {
              ctx.report({
                message: `${unit.path} has no job ${quote(a)}`,
                loc: ref.loc,
                symbol: sym.job(unit.path, a),
              });
            }
            continue; // needs.<missing> is reported by FP302
          }
          if (job.uses && job.uses.kind !== 'local-workflow') continue;
          if (job.uses && !ctx.index.calleeOf(job)) continue;
          const names = jobOutputNames(ctx.index, job);
          if (names.some((n) => n.toLowerCase() === c.toLowerCase())) continue;
          const guess = didYouMean(c, names);
          const callee = ctx.index.calleeOf(job);
          ctx.report({
            message: `jobs.${job.id} has no output ${quote(c)}${guess ? ` — did you mean ${quote(guess)}?` : ''}`,
            loc: ref.loc,
            symbol: sym.jobOutput(unit.path, job.id, c),
            related: [
              {
                loc: callee?.call?.loc ?? job.loc,
                message: `${callee ? `${callee.path} declares` : 'declared'} outputs: ${listNames(names)}`,
              },
            ],
          });
          continue;
        }
        if (ref.context === 'steps') {
          const steps = stepsInScope(unit, site.job);
          const step = steps.find((s) => s.id?.toLowerCase() === a.toLowerCase());
          if (!step) {
            const guess = didYouMean(
              a,
              steps.flatMap((s) => (s.id ? [s.id] : [])),
            );
            ctx.report({
              message: `No step with id ${quote(a)} in ${site.job ? `jobs.${site.job}` : unit.path}${guess ? ` — did you mean ${quote(guess)}?` : ''}`,
              loc: ref.loc,
              symbol: sym.stepOutput(unit.path, unit.kind === 'workflow' ? site.job : undefined, a, c ?? ''),
            });
            continue;
          }
          if (site.step !== undefined && step.index >= site.step) {
            ctx.report({
              message: `Step ${quote(a)} runs ${step.index === site.step ? 'as' : 'after'} this step, so its outputs are not available yet`,
              loc: ref.loc,
              symbol: sym.stepOutput(unit.path, unit.kind === 'workflow' ? site.job : undefined, a, c ?? ''),
              related: [{ loc: step.idLoc ?? step.loc, message: `step ${quote(a)} is defined here` }],
            });
            continue;
          }
          const action = ctx.index.actionOf(step);
          if (b !== 'outputs' || !c || c === '*' || c === '?' || !action) continue;
          // JavaScript and Docker actions may set outputs they do not declare; only composite outputs are fixed.
          if (action.using !== 'composite') continue;
          if (lookup(action.outputs, c)) continue;
          const names = Object.keys(action.outputs);
          const guess = didYouMean(c, names);
          ctx.report({
            message: `${action.path} has no output ${quote(c)}${guess ? ` — did you mean ${quote(guess)}?` : ''}`,
            loc: ref.loc,
            symbol: sym.output(action.path, c),
            related: [{ loc: step.uses?.loc ?? step.loc, message: `declared outputs: ${listNames(names)}` }],
          });
        }
      }
    }
  },
});

export const outputRefWithoutNeeds = defineRule({
  code: 'FP302',
  name: 'output-ref-without-needs',
  category: 'outputs',
  defaultSeverity: 'error',
  docs: {
    summary: '`needs.<job>` is read in a job that does not list `<job>` under `needs:`.',
    why:
      'The `needs` context only contains direct dependencies. Without the edge, the value is empty and the jobs may also ' +
      'run in parallel, so even a fixed name would race.',
    fix: 'Add the job to `needs:` (it is fine to list transitive dependencies explicitly).',
    examples: {
      bad: `deploy:
  needs: test
  run: deploy \${{ needs.build.outputs.version }}`,
      good: `deploy:
  needs: [build, test]`,
    },
  },
  check(ctx) {
    for (const wf of ctx.index.project.workflows.values()) {
      for (const { site, ref } of refsOf(wf)) {
        const a = ref.path[0];
        if (ref.context !== 'needs' || !site.job || !a || a === '*' || a === '?') continue;
        const job = wf.jobs[site.job];
        if (!job || job.needs.some((n) => n.id.toLowerCase() === a.toLowerCase())) continue;
        const exists = lookup(wf.jobs, a);
        ctx.report({
          message: exists
            ? `jobs.${site.job} reads needs.${a} but does not list ${quote(a)} under needs`
            : `jobs.${site.job} reads needs.${a}, but ${wf.path} has no job ${quote(a)}`,
          loc: ref.loc,
          symbol: sym.job(wf.path, a),
          related: [
            { loc: job.needs[0]?.loc ?? job.loc, message: `needs: ${listNames(job.needs.map((n) => n.id))}` },
          ],
          ...(exists ? { fix: `Add ${quote(a)} to jobs.${site.job}.needs.` } : {}),
        });
      }
    }
  },
});

export const unusedOutput = defineRule({
  code: 'FP303',
  name: 'unused-output',
  category: 'outputs',
  defaultSeverity: 'warning',
  docs: {
    summary: 'A job, workflow or action output is declared but no consumer reads it.',
    why: 'Unused outputs suggest a broken hand-off: either the consumer reads a different name, or the output is dead code.',
    fix: 'Remove the output, or make the intended consumer read it.',
  },
  check(ctx) {
    for (const wf of ctx.index.project.workflows.values()) {
      if (readsContextDynamically(wf, 'needs')) continue;
      for (const job of Object.values(wf.jobs)) {
        for (const o of Object.values(job.outputs)) {
          if (ctx.index.usagesOf(sym.jobOutput(wf.path, job.id, o.name)).length > 0) continue;
          ctx.report({
            message: `Output ${quote(o.name)} of jobs.${job.id} is never read`,
            loc: o.loc,
            symbol: sym.jobOutput(wf.path, job.id, o.name),
          });
        }
      }
      // Workflow outputs: only judge when there are local callers (external callers are invisible).
      const callers = ctx.index.callersOf(wf.path);
      if (!wf.call || callers.length === 0) continue;
      for (const o of Object.values(wf.call.outputs)) {
        const read = callers.some(
          (c) => ctx.index.usagesOf(sym.jobOutput(c.caller.path, c.job.id, o.name)).length > 0,
        );
        if (read) continue;
        ctx.report({
          message: `Workflow output ${quote(o.name)} of ${wf.path} is not read by any of its ${callers.length} caller${callers.length > 1 ? 's' : ''}`,
          loc: o.loc,
          symbol: sym.output(wf.path, o.name),
        });
      }
    }
    for (const action of ctx.index.project.actions.values()) {
      const users = ctx.index.usersOf(action.path);
      if (users.length === 0) continue;
      for (const o of Object.values(action.outputs)) {
        const read = users.some(
          (u) =>
            u.step.id &&
            ctx.index.usagesOf(sym.stepOutput(u.unit.path, u.job?.id, u.step.id, o.name)).length > 0,
        );
        if (read) continue;
        ctx.report({
          message: `Output ${quote(o.name)} of ${action.path} is not read by any of its ${users.length} user${users.length > 1 ? 's' : ''}`,
          loc: o.loc,
          symbol: sym.output(action.path, o.name),
        });
      }
    }
  },
});

export const stepOutputNeverWritten = defineRule({
  code: 'FP304',
  name: 'step-output-never-written',
  category: 'outputs',
  defaultSeverity: 'warning',
  docs: {
    summary: 'An output is read from a `run:` step whose script writes other outputs, but never this one.',
    why: 'The read evaluates to an empty string. This is typically a typo in the `echo "name=value" >> $GITHUB_OUTPUT` line.',
    fix: 'Write the output in the step (`echo "<name>=<value>" >> "$GITHUB_OUTPUT"`) or read the name it actually writes.',
    examples: {
      bad: `- id: meta
  run: echo "ver=1.2.3" >> "$GITHUB_OUTPUT"
...
version: \${{ steps.meta.outputs.version }}`,
      good: `- id: meta
  run: echo "version=1.2.3" >> "$GITHUB_OUTPUT"`,
    },
  },
  check(ctx) {
    for (const unit of ctx.index.units()) {
      for (const { site, ref } of refsOf(unit)) {
        const [a, b, c] = ref.path;
        if (ref.context !== 'steps' || b !== 'outputs' || !a || !c || c === '*' || c === '?') continue;
        const step = stepsInScope(unit, site.job).find((s) => s.id?.toLowerCase() === a.toLowerCase());
        if (!step) continue;
        const w = step.writesOutputs;
        if (!w.mentions || w.dynamic) continue;
        if (step.uses && !step.with.script) continue;
        if (w.names.some((n) => n.toLowerCase() === c.toLowerCase())) continue;
        const guess = didYouMean(c, w.names);
        ctx.report({
          message: `Step ${quote(a)} never writes output ${quote(c)} (it writes ${listNames(w.names)})${guess ? ` — did you mean ${quote(guess)}?` : ''}`,
          loc: ref.loc,
          symbol: sym.stepOutput(unit.path, unit.kind === 'workflow' ? site.job : undefined, a, c),
          related: [{ loc: step.runLoc ?? step.loc, message: 'outputs are written here' }],
        });
      }
    }
  },
});

export const outputRules: RuleDefinition[] = [
  undefinedOutputRef,
  outputRefWithoutNeeds,
  unusedOutput,
  stepOutputNeverWritten,
];

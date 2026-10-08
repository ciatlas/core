import { type CallSite, sym } from '../graph';
import { lookup } from '../ir';
import { defineRule, type RuleDefinition } from './types';
import { chainRelated, isCallOnly, listNames, quote, refsOf } from './util';

export const callCycle = defineRule({
  code: 'WFC601',
  name: 'call-cycle',
  category: 'structure',
  defaultSeverity: 'error',
  docs: {
    summary: 'Reusable workflows call each other in a cycle.',
    why: 'GitHub rejects recursive reusable workflow calls when the run starts.',
    fix: 'Break the cycle by extracting the shared jobs into a separate workflow that neither side calls back.',
  },
  check(ctx) {
    const byCaller = callsByCaller(ctx.index.callSites);
    const components = callComponents([...ctx.index.project.workflows.keys()], byCaller);
    for (const component of components) {
      const members = new Set(component);
      const start = [...component].sort()[0]!;
      const selfLoop = (byCaller.get(start) ?? []).find((c) => c.callee.path === start);
      if (component.length === 1 && !selfLoop) continue;
      // Shortest cycle through `start`, by breadth-first search inside the component.
      const via = new Map<string, CallSite>();
      const queue = [start];
      let closing: CallSite | undefined = selfLoop;
      while (queue.length && !closing) {
        const v = queue.shift()!;
        for (const call of byCaller.get(v) ?? []) {
          const w = call.callee.path;
          if (!members.has(w)) continue;
          if (w === start) {
            closing = call;
            break;
          }
          if (!via.has(w)) {
            via.set(w, call);
            queue.push(w);
          }
        }
      }
      if (!closing) continue;
      const cycle: CallSite[] = [closing];
      for (let v = closing.caller.path; v !== start; v = via.get(v)!.caller.path) cycle.unshift(via.get(v)!);
      ctx.report({
        message: `Call cycle: ${[...cycle.map((c) => c.caller.path), start].join(' → ')}`,
        loc: closing.job.uses?.loc ?? closing.job.loc,
        symbol: start,
        related: chainRelated(cycle),
      });
    }
  },
});

/** Calls grouped by calling workflow (precomputed once instead of filtering every call per visit). */
function callsByCaller(calls: CallSite[]): Map<string, CallSite[]> {
  const out = new Map<string, CallSite[]>();
  for (const c of calls) {
    const list = out.get(c.caller.path);
    if (list) list.push(c);
    else out.set(c.caller.path, [c]);
  }
  return out;
}

/**
 * Strongly connected components of the call graph (Tarjan): linear in the number of calls. Components come in
 * reverse topological order — every component after the ones it calls.
 */
function callComponents(paths: string[], byCaller: Map<string, CallSite[]>): string[][] {
  const order = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;
  const strongConnect = (v: string) => {
    order.set(v, counter);
    low.set(v, counter++);
    stack.push(v);
    onStack.add(v);
    for (const call of byCaller.get(v) ?? []) {
      const w = call.callee.path;
      if (!order.has(w)) {
        strongConnect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, order.get(w)!));
      }
    }
    if (low.get(v) === order.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      components.push(component);
    }
  };
  for (const path of [...paths].sort()) if (!order.has(path)) strongConnect(path);
  return components;
}

export const nestingDepth = defineRule({
  code: 'WFC602',
  name: 'nesting-depth',
  category: 'structure',
  defaultSeverity: 'error',
  docs: {
    summary:
      'A chain of reusable workflow calls is deeper than the configured limit (`limits.nestingDepth`).',
    why:
      'GitHub limits how deeply reusable workflows can be nested and fails the run when the limit is exceeded. Deep chains ' +
      'are also where values get lost between levels.',
    fix: 'Flatten the chain (call leaf workflows directly from a higher level). GitHub allows at most 10 levels; lower `limits.nestingDepth` to enforce a stricter internal limit.',
  },
  check(ctx) {
    const limit = ctx.config.limits.nestingDepth;
    const byCaller = callsByCaller(ctx.index.callSites);
    const components = callComponents([...ctx.index.project.workflows.keys()], byCaller);
    const componentOf = new Map<string, number>();
    components.forEach((c, i) => {
      for (const path of c) componentOf.set(path, i);
    });
    const internal = (c: CallSite) => componentOf.get(c.caller.path) === componentOf.get(c.callee.path);

    // Longest chain (in workflows, counting the top level) that reaches each workflow, computed over the components
    // from the top-level workflows down: linear in the number of calls outside cycles. Inside a cycle (WFC601) a
    // workflow counts the shortest way from where the chain enters the cycle, so the depth never overstates a real
    // chain and does not depend on file names.
    const entry = new Map<string, { depth: number; call?: CallSite }>();
    const reach = new Map<string, { depth: number; from: string; path: CallSite[] }>();
    for (let i = components.length - 1; i >= 0; i--) {
      const members = components[i]!;
      for (const v of members) {
        let best: { depth: number; call?: CallSite } = { depth: 1 };
        for (const c of ctx.index.callersOf(v)) {
          if (internal(c)) continue;
          const d = (reach.get(c.caller.path)?.depth ?? 1) + 1;
          if (d > best.depth) best = { depth: d, call: c };
        }
        entry.set(v, best);
      }
      for (const u of [...members].sort()) {
        // Breadth-first inside the component from u: shortest call path to every other member.
        const paths = new Map<string, CallSite[]>([[u, []]]);
        const queue = [u];
        while (queue.length) {
          const v = queue.shift()!;
          for (const c of byCaller.get(v) ?? []) {
            const w = c.callee.path;
            if (!internal(c) || paths.has(w)) continue;
            paths.set(w, [...paths.get(v)!, c]);
            queue.push(w);
          }
        }
        const start = entry.get(u)!.depth;
        for (const [w, path] of paths) {
          const d = start + path.length;
          if (d > (reach.get(w)?.depth ?? 0)) reach.set(w, { depth: d, from: u, path });
        }
      }
    }
    const depthOf = (path: string) => reach.get(path)?.depth ?? 1;
    const chainTo = (path: string): CallSite[] => {
      const r = reach.get(path);
      if (!r) return [];
      const via = entry.get(r.from)?.call;
      return [...(via ? [...chainTo(via.caller.path), via] : []), ...r.path];
    };

    for (const call of ctx.index.callSites) {
      // Report where the longest chain first crosses the limit.
      if (depthOf(call.caller.path) !== limit) continue;
      let chain: CallSite[];
      if (!internal(call)) chain = [...chainTo(call.caller.path), call];
      else if (reach.get(call.callee.path)?.path.at(-1) === call && depthOf(call.callee.path) === limit + 1)
        chain = chainTo(call.callee.path);
      else continue;
      ctx.report({
        message: `Call chain is ${chain.length + 1} workflows deep (limit ${limit}): ${[chain[0]!.caller.path, ...chain.map((c) => c.callee.path)].join(' → ')}`,
        loc: call.job.uses?.loc ?? call.job.loc,
        symbol: call.callee.path,
        related: chainRelated(chain),
      });
    }
  },
});

export const remoteUnverified = defineRule({
  code: 'WFC603',
  name: 'remote-unverified',
  category: 'structure',
  defaultSeverity: 'info',
  docs: {
    summary: 'A job calls a reusable workflow in another repository; its interface is not verified.',
    why: 'wfc analyzes this repository only, so inputs, secrets and outputs of the remote workflow are taken on trust.',
    fix: 'Nothing to fix. If the workflow lives in this repository, set `repository: owner/repo` in the config so it resolves locally.',
  },
  check(ctx) {
    for (const wf of ctx.index.project.workflows.values()) {
      for (const job of Object.values(wf.jobs)) {
        if (job.uses?.kind !== 'remote-workflow') continue;
        ctx.report({
          message: `jobs.${job.id} calls remote workflow ${job.uses.raw}; its interface is not verified`,
          loc: job.uses.loc,
          symbol: sym.remote(job.uses.raw),
        });
      }
    }
  },
});

export const needsWithoutData = defineRule({
  code: 'WFC604',
  name: 'needs-without-data',
  category: 'structure',
  defaultSeverity: 'off',
  docs: {
    summary: 'A job lists another job under `needs:` but never reads its outputs or result (opt-in).',
    why:
      'Ordering-only dependencies are legitimate (deploy after test), but unexplained ones serialize the pipeline. ' +
      'This rule is off by default; enable it to audit the critical path.',
    fix: 'Remove the dependency if it is not needed for ordering, or keep it and disable the rule for that job.',
  },
  check(ctx) {
    for (const wf of ctx.index.project.workflows.values()) {
      const readsByJob = new Map<string, Set<string>>();
      for (const { site, ref } of refsOf(wf)) {
        if (ref.context !== 'needs' || !site.job || !ref.path[0]) continue;
        const set = readsByJob.get(site.job) ?? new Set();
        set.add(ref.path[0].toLowerCase());
        readsByJob.set(site.job, set);
      }
      for (const job of Object.values(wf.jobs)) {
        const reads = readsByJob.get(job.id) ?? new Set();
        if (reads.has('*') || reads.has('?')) continue;
        for (const n of job.needs) {
          if (reads.has(n.id.toLowerCase())) continue;
          ctx.report({
            message: `jobs.${job.id} needs ${quote(n.id)} only for ordering — it never reads needs.${n.id}`,
            loc: n.loc,
            symbol: sym.job(wf.path, job.id),
          });
        }
      }
    }
  },
});

export const largeInterface = defineRule({
  code: 'WFC605',
  name: 'large-interface',
  category: 'structure',
  defaultSeverity: 'info',
  docs: {
    summary: 'A reusable workflow declares more inputs than `limits.maxInputs`.',
    why:
      'Interfaces with dozens of inputs are where forgotten bindings and dead knobs hide. Related values are easier to keep ' +
      'consistent when grouped.',
    fix: 'Group related inputs into one JSON input (`fromJSON(inputs.test-config)`), split the workflow, or move constants into the callee.',
  },
  check(ctx) {
    for (const wf of ctx.index.project.workflows.values()) {
      const n = Object.keys(wf.call?.inputs ?? {}).length;
      if (!wf.call || n <= ctx.config.limits.maxInputs) continue;
      ctx.report({
        message: `${wf.path} declares ${n} workflow_call inputs (limit ${ctx.config.limits.maxInputs})`,
        loc: wf.call.loc,
        symbol: wf.path,
      });
    }
  },
});

export const missingLocalTarget = defineRule({
  code: 'WFC606',
  name: 'missing-local-target',
  category: 'structure',
  defaultSeverity: 'error',
  docs: {
    summary: 'A local `uses: ./...` points to a workflow or action that does not exist.',
    why: 'The job or step fails as soon as it is reached, usually after a rename or move.',
    fix: 'Fix the path (it is relative to the repository root), or restore the missing file.',
  },
  check(ctx) {
    for (const m of ctx.index.project.invalidTargets ?? []) {
      ctx.report({
        message: `${quote(m.uses.target ?? m.uses.raw)} is not a reusable workflow: they must be .yml/.yaml files directly in .github/workflows`,
        loc: m.uses.loc,
        symbol: m.uses.target ?? m.uses.raw,
      });
    }
    for (const m of ctx.index.project.missing) {
      ctx.report({
        message: `${m.uses.kind === 'local-workflow' ? 'Workflow' : 'Action'} ${quote(m.uses.target ?? m.uses.raw)} does not exist`,
        loc: m.uses.loc,
        symbol: m.uses.target ?? m.uses.raw,
      });
    }
  },
});

export const unreferencedReusableWorkflow = defineRule({
  code: 'WFC607',
  name: 'unreferenced-reusable-workflow',
  category: 'structure',
  defaultSeverity: 'info',
  docs: {
    summary: 'A workflow can only be triggered by `workflow_call`, but nothing in this repository calls it.',
    why: 'It is either dead code or called from other repositories — worth knowing before changing its interface.',
    fix: 'Delete it if unused; otherwise document its external callers.',
  },
  check(ctx) {
    for (const wf of ctx.index.project.workflows.values()) {
      if (!isCallOnly(wf) || ctx.index.callersOf(wf.path).length > 0) continue;
      ctx.report({
        message: `${wf.path} is only triggered by workflow_call and has no callers in this repository`,
        loc: wf.call?.loc ?? wf.source.loc(0, 0),
        symbol: wf.path,
      });
    }
  },
});

export const undefinedNeedsJob = defineRule({
  code: 'WFC608',
  name: 'undefined-needs-job',
  category: 'structure',
  defaultSeverity: 'error',
  docs: {
    summary: 'A job lists a job under `needs:` that does not exist.',
    why: 'GitHub rejects the workflow when it is triggered.',
    fix: 'Fix the job id or remove the dependency.',
  },
  check(ctx) {
    for (const wf of ctx.index.project.workflows.values()) {
      const ids = Object.keys(wf.jobs);
      for (const job of Object.values(wf.jobs)) {
        for (const n of job.needs) {
          if (lookup(wf.jobs, n.id)) continue;
          ctx.report({
            message: `jobs.${job.id} needs ${quote(n.id)}, which is not a job in ${wf.path} (jobs: ${listNames(ids)})`,
            loc: n.loc,
            symbol: sym.job(wf.path, n.id),
          });
        }
      }
    }
  },
});

export const calleeNotReusable = defineRule({
  code: 'WFC609',
  name: 'callee-not-reusable',
  category: 'structure',
  defaultSeverity: 'error',
  docs: {
    summary: 'A job calls a local workflow that has no `on.workflow_call` trigger.',
    why:
      'Only workflows with `workflow_call` can be called. GitHub rejects the caller ("is not a reusable workflow"), and none ' +
      'of the callee’s `workflow_dispatch` inputs count as a call interface.',
    fix: 'Add `on: workflow_call:` (with the inputs, secrets and outputs the callers need) to the called workflow, or call the right file.',
    examples: {
      bad: `# deploy.yml
on:
  workflow_dispatch:
    inputs:
      target: { type: string, required: true }`,
      good: `on:
  workflow_dispatch: ...
  workflow_call:
    inputs:
      target: { type: string, required: true }`,
    },
  },
  check(ctx) {
    for (const wf of ctx.index.project.workflows.values()) {
      for (const job of Object.values(wf.jobs)) {
        const target = ctx.index.targetOf(job);
        if (!target || target.call) continue;
        ctx.report({
          message: `jobs.${job.id} calls ${target.path}, which is not reusable (no \`on.workflow_call\` trigger; triggers: ${listNames(target.triggers)})`,
          loc: job.uses?.loc ?? job.loc,
          symbol: target.path,
          related: [
            {
              loc: target.dispatch?.loc ?? target.source.loc(0, 0),
              message: 'add workflow_call to this workflow',
            },
          ],
        });
      }
    }
  },
});

export const structureRules: RuleDefinition[] = [
  calleeNotReusable,
  callCycle,
  nestingDepth,
  remoteUnverified,
  needsWithoutData,
  largeInterface,
  missingLocalTarget,
  unreferencedReusableWorkflow,
  undefinedNeedsJob,
];

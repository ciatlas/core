import { type CallSite, sym } from '../graph';
import { lookup } from '../ir';
import type { Loc } from '../source';
import { defineRule, type RelatedLocation, type RuleDefinition } from './types';
import { chainRelated, isCallOnly, listNames, quote, refsOf } from './util';

export const callCycle = defineRule({
  code: 'FP601',
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
  code: 'FP602',
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
    // from the top-level workflows down: linear in the number of calls outside cycles. Inside a cycle (FP601) a
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
  code: 'FP603',
  name: 'remote-unverified',
  category: 'structure',
  defaultSeverity: 'info',
  docs: {
    summary: 'A job calls a reusable workflow in another repository; its interface is not verified.',
    why: 'flowpact analyzes this repository only, so inputs, secrets and outputs of the remote workflow are taken on trust.',
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
  code: 'FP604',
  name: 'needs-without-data',
  category: 'structure',
  defaultSeverity: 'off',
  generatedFiles: 'skip',
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
  code: 'FP605',
  name: 'large-interface',
  category: 'structure',
  defaultSeverity: 'info',
  generatedFiles: 'skip',
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
  code: 'FP606',
  name: 'missing-local-target',
  category: 'structure',
  defaultSeverity: 'error',
  docs: {
    summary:
      'A local `uses: ./...` or `uses: $/...` points to a workflow or action that does not exist where GitHub looks for it, or is written in a form GitHub rejects.',
    why:
      'The job or step fails as soon as it is reached, usually after a rename or move. A step’s `./path` is relative to the ' +
      'runner’s workspace: flowpact maps it through the `actions/checkout` steps before it (for a composite action, each ' +
      'caller’s) and reports it when it lands in this repository but is missing, or when no checkout puts this repository ' +
      'where it points. Paths it cannot read are FP610.',
    fix:
      'Fix the path or restore the missing file. A step’s `./path` includes the `path:` this repository is checked out to, ' +
      'and needs a checkout that puts it there; `$/path` and a job’s `./path` are relative to the repository root whatever ' +
      'the checkout, and `$/` takes no `@ref` (it always runs the running commit).',
    examples: {
      bad: `- uses: actions/checkout@v5
  with:
    path: src/app
- uses: ./src/app/.github/actions/biuld`,
      good: `- uses: actions/checkout@v5
  with:
    path: src/app
- uses: ./src/app/.github/actions/build
# or, whatever the checkout:
- uses: $/.github/actions/build`,
    },
  },
  check(ctx) {
    for (const m of ctx.index.project.invalidTargets ?? []) {
      const target = m.uses.target ?? m.uses.raw;
      ctx.report({
        message:
          m.reason === 'self-ref'
            ? `${quote(m.uses.raw.trim())} has an @ref, which GitHub rejects: \`$/\` always runs this repository at the running commit`
            : `${quote(target)} is not a reusable workflow: they must be .yml/.yaml files directly in .github/workflows`,
        loc: m.uses.loc,
        symbol: target,
        ...(m.reason === 'self-ref'
          ? {
              fix: `Write \`$/${target}\` without @${m.uses.selfRef}, or reference another commit as owner/repo/path@ref.`,
            }
          : {}),
      });
    }
    for (const m of ctx.index.project.missing) {
      const target = m.target ?? m.uses.target ?? m.uses.raw;
      const related: RelatedLocation[] = [];
      const checkedOut = (c: { path: string; loc: Loc }) =>
        related.push({ loc: c.loc, message: `checks this repository out at ${quote(c.path)}` });
      let where = '';
      let fix: string | undefined;
      if (m.checkout) {
        where = ` (${m.uses.raw.trim()} is in the checkout of this repository at ${quote(m.checkout.path)})`;
        checkedOut(m.checkout);
      } else if (m.elsewhere) {
        const first = m.elsewhere[0];
        where = first
          ? ` (this repository is checked out at ${listNames(m.elsewhere.map((c) => quote(c.path)))}, not at the workspace root)`
          : ' (no step checks this repository out at the workspace root)';
        m.elsewhere.forEach(checkedOut);
        fix = first
          ? `A step’s ./path is relative to the workspace, where this repository is at ${quote(first.path)}: a path in it starts with ./${first.path}/. Or use $/${target}, which always means this repository.`
          : `A step’s ./path is relative to the workspace, and no step puts this repository at its root: check it out there first (actions/checkout without path:), or use $/${target}, which always means this repository.`;
      }
      // A composite action's step that resolves for other callers: name the one it fails for.
      let when = '';
      const caller = m.via?.[0];
      if (caller) {
        when = ` when ${m.from} runs in ${caller.job !== undefined ? `job ${quote(caller.job)} of ` : ''}${caller.from}`;
        for (const v of m.via ?? []) related.push({ loc: v.loc, message: `uses ${v.action} here` });
      }
      const what = `${m.uses.kind === 'local-workflow' ? 'Workflow' : 'Action'} ${quote(target)}`;
      ctx.report({
        message: `${what} ${m.inRepository ? 'is not in the workspace' : 'does not exist'}${when}${where}`,
        loc: m.uses.loc,
        symbol: target,
        ...(related.length ? { related } : {}),
        ...(fix !== undefined ? { fix } : {}),
      });
    }
  },
});

export const workspaceUnverified = defineRule({
  code: 'FP610',
  name: 'workspace-unverified',
  category: 'structure',
  defaultSeverity: 'info',
  docs: {
    summary:
      'A step’s `uses: ./...` points to a place in the runner’s workspace that flowpact cannot read, so the action is not verified.',
    why:
      'GitHub resolves a step’s `./path` against the workspace, not the repository. When the path lies in another repository’s ' +
      'checkout, in a checkout of this repository at another ref, outside the workspace, where an earlier step’s script ' +
      'writes, or where no checkout of this repository puts it, flowpact cannot read the action: its inputs, outputs and the ' +
      'path itself are taken on trust.',
    fix:
      'Nothing to fix if this is intended. To have it checked, reference another repository’s action as `owner/repo/path@ref`, ' +
      'and this repository’s as `$/path` (or check this repository out where the path points).',
    examples: {
      bad: `- uses: actions/checkout@v5
  with:
    repository: acme/shared-actions
    path: shared
- uses: ./shared/setup`,
      good: `- uses: acme/shared-actions/setup@v2`,
    },
  },
  check(ctx) {
    for (const u of ctx.index.project.unverified ?? []) {
      const path = quote(u.uses.raw.trim());
      const related: RelatedLocation[] = [];
      let message: string;
      switch (u.reason) {
        case 'other-repository':
          message = `${path} is in the checkout of ${u.checkout?.repository} at ${quote(u.checkout?.path ?? '.')}; its interface is not verified`;
          break;
        case 'outside-workspace':
          message = `${path} points outside the workspace, so it only exists at runtime; it is not verified`;
          break;
        case 'created-at-runtime':
          message = `${path} is not in this repository; an earlier step writes there (\`${u.writer?.command}\`), so it is not verified`;
          break;
        case 'other-ref':
          message = `${path} is not in this repository’s working tree, but may be at ${quote(u.checkout?.ref ?? '')}, the ref checked out at ${quote(u.checkout?.path ?? '.')}; it is not verified`;
          break;
        default:
          message = u.checkout
            ? `${path} is not in this repository and may be in the checkout at ${quote(u.checkout.path)}, a path computed at runtime; it is not verified`
            : `${path} is not in this repository, and no checkout of this repository covers it; it is not verified`;
      }
      if (u.checkout) {
        const what =
          u.checkout.repository ??
          (u.checkout.ref !== undefined
            ? `ref ${quote(u.checkout.ref)} of this repository`
            : 'this repository');
        related.push({ loc: u.checkout.loc, message: `checks out ${what} at ${quote(u.checkout.path)}` });
      }
      if (u.writer)
        related.push({
          loc: u.writer.loc,
          message: `\`${u.writer.command}\` here writes to ${quote(u.writer.path)}`,
        });
      ctx.report({
        message,
        loc: u.uses.loc,
        symbol: u.uses.raw.trim(),
        ...(related.length ? { related } : {}),
      });
    }
  },
});

export const unreferencedReusableWorkflow = defineRule({
  code: 'FP607',
  name: 'unreferenced-reusable-workflow',
  category: 'structure',
  defaultSeverity: 'info',
  generatedFiles: 'skip',
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
  code: 'FP608',
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
  code: 'FP609',
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
  workspaceUnverified,
];

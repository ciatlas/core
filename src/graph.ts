import type {
  ActionDecl,
  ExprSite,
  JobDecl,
  LocatedRef,
  StepDecl,
  UnitDecl,
  UsesRef,
  WorkflowDecl,
} from './ir';
import { lookup } from './ir';
import type { Loc } from './source';

export type SymbolKind =
  | 'workflow'
  | 'action'
  | 'remote'
  | 'job'
  | 'input'
  | 'secret'
  | 'output'
  | 'job-output'
  | 'step-output'
  | 'env'
  | 'matrix'
  | 'var'
  | 'unresolved';

export interface GraphNode {
  id: string;
  kind: SymbolKind;
  label: string;
  unit?: string;
  loc?: Loc;
}

export type EdgeKind =
  /** job → reusable workflow */
  | 'calls'
  /** step → composite action */
  | 'uses'
  /** job → job it needs */
  | 'needs'
  /** value flows from one symbol into another (input binding, output propagation, env definition) */
  | 'flows'
  /** caller job passes every secret with `secrets: inherit` */
  | 'inherits';

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  loc?: Loc;
  /** The expression site carrying the value, for `flows` edges. */
  siteId?: number;
}

/** One place where a symbol is read. */
export interface Usage {
  symbol: string;
  site: ExprSite;
  ref: LocatedRef;
  /** The symbol the site defines (e.g. a callee input), when the value flows on. */
  sink?: string;
}

export interface Project {
  root: string;
  repository?: string;
  workflows: Map<string, WorkflowDecl>;
  actions: Map<string, ActionDecl>;
  /** Files the user asked to analyze; findings outside these are dropped. Empty = everything. */
  targets: Set<string>;
  /** Requested paths that do not exist (or lie outside the repository). */
  missingTargets?: string[];
  /** Requested paths that exist but are neither workflows nor action metadata. */
  ignoredTargets?: string[];
  /** Local `uses:` targets that do not exist. */
  missing: { uses: UsesRef; from: string; job?: string; step?: number }[];
  /** Job-level local `uses:` that point outside .github/workflows (not loaded). */
  invalidTargets?: { uses: UsesRef; from: string; job?: string; step?: number }[];
  /** True when a requested path was the repository root itself. */
  wholeRepository?: boolean;
}

export const sym = {
  input: (unit: string, name: string) => `${unit}#inputs.${name}`,
  secret: (unit: string, name: string) => `${unit}#secrets.${name}`,
  output: (unit: string, name: string) => `${unit}#outputs.${name}`,
  job: (unit: string, job: string) => `${unit}#jobs.${job}`,
  jobOutput: (unit: string, job: string, name: string) => `${unit}#jobs.${job}.outputs.${name}`,
  stepOutput: (unit: string, job: string | undefined, step: string, name: string) =>
    job === undefined
      ? `${unit}#steps.${step}.outputs.${name}`
      : `${unit}#jobs.${job}.steps.${step}.outputs.${name}`,
  env: (unit: string, job: string | undefined, name: string) =>
    job === undefined ? `${unit}#env.${name}` : `${unit}#jobs.${job}.env.${name}`,
  matrix: (unit: string, job: string, key: string) => `${unit}#jobs.${job}.matrix.${key}`,
  var: (name: string) => `vars.${name}`,
  remote: (raw: string) => `remote:${raw}`,
};

export interface CallSite {
  caller: WorkflowDecl;
  job: JobDecl;
  callee: WorkflowDecl;
}

export interface ActionUse {
  unit: UnitDecl;
  job?: JobDecl;
  step: StepDecl;
  action: ActionDecl;
}

/**
 * The analyzed repository as a queryable graph: who calls whom, which expression reads which symbol,
 * and where each value flows next.
 */
export class ProjectIndex {
  readonly nodes = new Map<string, GraphNode>();
  readonly edges: GraphEdge[] = [];
  readonly usages = new Map<string, Usage[]>();
  readonly callSites: CallSite[] = [];
  readonly actionUses: ActionUse[] = [];
  private readonly sitesById = new Map<number, ExprSite>();

  constructor(readonly project: Project) {
    for (const wf of project.workflows.values()) this.indexWorkflow(wf);
    for (const a of project.actions.values()) this.indexAction(a);
    for (const unit of this.units()) for (const site of unit.sites) this.indexSite(unit, site);
  }

  units(): UnitDecl[] {
    return [...this.project.workflows.values(), ...this.project.actions.values()];
  }

  unit(path: string): UnitDecl | undefined {
    return this.project.workflows.get(path) ?? this.project.actions.get(path);
  }

  site(id: number): ExprSite | undefined {
    return this.sitesById.get(id);
  }

  callersOf(workflowPath: string): CallSite[] {
    return this.callSites.filter((c) => c.callee.path === workflowPath);
  }

  usersOf(actionPath: string): ActionUse[] {
    return this.actionUses.filter((u) => u.action.path === actionPath);
  }

  /** The reusable workflow a job calls. Workflows without `on.workflow_call` are not callable (see WFC609). */
  calleeOf(job: JobDecl): WorkflowDecl | undefined {
    const wf = this.targetOf(job);
    return wf?.call ? wf : undefined;
  }

  /** The local workflow file a job's `uses:` points at, reusable or not. */
  targetOf(job: JobDecl): WorkflowDecl | undefined {
    if (job.uses?.kind !== 'local-workflow' || !job.uses.target) return undefined;
    if (!/^\.github\/workflows\/[^/]+\.ya?ml$/i.test(job.uses.target)) return undefined;
    return this.project.workflows.get(job.uses.target);
  }

  actionOf(step: StepDecl): ActionDecl | undefined {
    if (step.uses?.kind !== 'local-action' || !step.uses.target) return undefined;
    return this.project.actions.get(step.uses.target);
  }

  usagesOf(symbol: string): Usage[] {
    return this.usages.get(symbol) ?? [];
  }

  outgoing(symbol: string, kind?: EdgeKind): GraphEdge[] {
    return this.edges.filter((e) => e.from === symbol && (!kind || e.kind === kind));
  }

  incoming(symbol: string, kind?: EdgeKind): GraphEdge[] {
    return this.edges.filter((e) => e.to === symbol && (!kind || e.kind === kind));
  }

  /** Serializable snapshot (used by `--dump-graph` and the JSON report). */
  toJSON() {
    return {
      nodes: [...this.nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
      edges: [...this.edges].sort(
        (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind),
      ),
    };
  }

  private node(n: GraphNode) {
    if (!this.nodes.has(n.id)) this.nodes.set(n.id, n);
    return n.id;
  }

  private edge(e: GraphEdge) {
    this.edges.push(e);
  }

  private indexWorkflow(wf: WorkflowDecl) {
    const u = wf.path;
    this.node({ id: u, kind: 'workflow', label: wf.name ?? u, unit: u });
    for (const i of Object.values(wf.call?.inputs ?? {}))
      this.node({ id: sym.input(u, i.name), kind: 'input', label: `inputs.${i.name}`, unit: u, loc: i.loc });
    for (const i of Object.values(wf.dispatch?.inputs ?? {}))
      this.node({ id: sym.input(u, i.name), kind: 'input', label: `inputs.${i.name}`, unit: u, loc: i.loc });
    for (const s of Object.values(wf.call?.secrets ?? {}))
      this.node({
        id: sym.secret(u, s.name),
        kind: 'secret',
        label: `secrets.${s.name}`,
        unit: u,
        loc: s.loc,
      });
    for (const o of Object.values(wf.call?.outputs ?? {}))
      this.node({
        id: sym.output(u, o.name),
        kind: 'output',
        label: `outputs.${o.name}`,
        unit: u,
        loc: o.loc,
      });
    for (const e of Object.values(wf.env))
      this.node({
        id: sym.env(u, undefined, e.name),
        kind: 'env',
        label: `env.${e.name}`,
        unit: u,
        loc: e.loc,
      });

    for (const job of Object.values(wf.jobs)) {
      const jid = this.node({
        id: sym.job(u, job.id),
        kind: 'job',
        label: `jobs.${job.id}`,
        unit: u,
        loc: job.loc,
      });
      for (const n of job.needs) this.edge({ from: jid, to: sym.job(u, n.id), kind: 'needs', loc: n.loc });
      for (const o of Object.values(job.outputs))
        this.node({
          id: sym.jobOutput(u, job.id, o.name),
          kind: 'job-output',
          label: `jobs.${job.id}.outputs.${o.name}`,
          unit: u,
          loc: o.loc,
        });
      for (const e of Object.values(job.env))
        this.node({
          id: sym.env(u, job.id, e.name),
          kind: 'env',
          label: `env.${e.name}`,
          unit: u,
          loc: e.loc,
        });
      for (const d of job.matrix?.dims ?? [])
        this.node({
          id: sym.matrix(u, job.id, d.name),
          kind: 'matrix',
          label: `matrix.${d.name}`,
          unit: u,
          loc: d.loc,
        });
      for (const inc of job.matrix?.include ?? [])
        for (const [k, loc] of Object.entries(inc.keyLocs))
          this.node({ id: sym.matrix(u, job.id, k), kind: 'matrix', label: `matrix.${k}`, unit: u, loc });

      if (job.uses) {
        const callee = this.calleeOf(job);
        if (callee) {
          this.callSites.push({ caller: wf, job, callee });
          this.edge({ from: jid, to: callee.path, kind: 'calls', loc: job.uses.loc });
          // A reusable job's outputs are the callee's workflow outputs.
          for (const o of Object.values(callee.call?.outputs ?? {})) {
            const jo = this.node({
              id: sym.jobOutput(u, job.id, o.name),
              kind: 'job-output',
              label: `jobs.${job.id}.outputs.${o.name}`,
              unit: u,
              loc: job.loc,
            });
            this.edge({ from: sym.output(callee.path, o.name), to: jo, kind: 'flows', loc: o.loc });
          }
          if (job.secretsInherit) {
            this.edge({
              from: jid,
              to: callee.path,
              kind: 'inherits',
              ...(job.secretsLoc ? { loc: job.secretsLoc } : {}),
            });
          }
        } else if (job.uses.kind === 'remote-workflow') {
          const r = this.node({ id: sym.remote(job.uses.raw), kind: 'remote', label: job.uses.raw });
          this.edge({ from: jid, to: r, kind: 'calls', loc: job.uses.loc });
        }
      }
      for (const step of job.steps) this.indexStep(wf, job, step);
    }
  }

  private indexStep(unit: UnitDecl, job: JobDecl | undefined, step: StepDecl) {
    const action = this.actionOf(step);
    if (!action) return;
    this.actionUses.push({ unit, ...(job ? { job } : {}), step, action });
    if (step.uses) {
      const from = job ? sym.job(unit.path, job.id) : unit.path;
      this.edge({ from, to: action.path, kind: 'uses', loc: step.uses.loc });
    }
    if (step.id) {
      for (const o of Object.values(action.outputs)) {
        const so = this.node({
          id: sym.stepOutput(unit.path, job?.id, step.id, o.name),
          kind: 'step-output',
          label: `steps.${step.id}.outputs.${o.name}`,
          unit: unit.path,
          loc: step.idLoc ?? step.loc,
        });
        this.edge({ from: sym.output(action.path, o.name), to: so, kind: 'flows', loc: o.loc });
      }
    }
  }

  private indexAction(a: ActionDecl) {
    const u = a.path;
    this.node({ id: u, kind: 'action', label: a.name ?? u, unit: u });
    for (const i of Object.values(a.inputs))
      this.node({ id: sym.input(u, i.name), kind: 'input', label: `inputs.${i.name}`, unit: u, loc: i.loc });
    for (const o of Object.values(a.outputs))
      this.node({
        id: sym.output(u, o.name),
        kind: 'output',
        label: `outputs.${o.name}`,
        unit: u,
        loc: o.loc,
      });
    for (const step of a.steps) this.indexStep(a, undefined, step);
  }

  /** Which symbol does the site's value define? (e.g. `with: { foo: ... }` on a reusable call defines the callee's `inputs.foo`). */
  sinkOf(unit: UnitDecl, site: ExprSite): string | undefined {
    const key = site.key;
    if (key === undefined) return undefined;
    switch (site.field) {
      case 'job.with':
      case 'job.secrets': {
        const job = unit.kind === 'workflow' && site.job ? unit.jobs[site.job] : undefined;
        const callee = job && this.calleeOf(job);
        if (!callee) return undefined;
        const decls = site.field === 'job.with' ? callee.call?.inputs : callee.call?.secrets;
        const name = (decls && lookup(decls, key)?.name) ?? key;
        return site.field === 'job.with' ? sym.input(callee.path, name) : sym.secret(callee.path, name);
      }
      case 'step.with': {
        const step = this.stepOf(unit, site);
        const action = step && this.actionOf(step);
        if (!action) return undefined;
        return sym.input(action.path, lookup(action.inputs, key)?.name ?? key);
      }
      case 'job.output':
        return site.job ? sym.jobOutput(unit.path, site.job, key) : undefined;
      case 'workflow.output':
      case 'action.output':
        return sym.output(unit.path, key);
      case 'workflow.env':
        return sym.env(unit.path, undefined, key);
      case 'job.env':
        return site.job ? sym.env(unit.path, site.job, key) : undefined;
      default:
        return undefined;
    }
  }

  stepOf(unit: UnitDecl, site: ExprSite): StepDecl | undefined {
    if (site.step === undefined) return undefined;
    if (unit.kind === 'action') return unit.steps[site.step];
    return site.job ? unit.jobs[site.job]?.steps[site.step] : undefined;
  }

  /** Resolves a reference inside `site` to the symbol it reads, or `undefined` for runtime-only contexts. */
  resolveRef(unit: UnitDecl, site: ExprSite, ref: LocatedRef): string | undefined {
    const [a, b, c] = ref.path;
    switch (ref.context) {
      case 'inputs': {
        if (!a || a === '*' || a === '?') return undefined;
        return sym.input(unit.path, this.canonicalInput(unit, a));
      }
      case 'github':
        // `github.event.inputs` is this workflow's own input only when it is dispatched directly.
        if (
          a === 'event' &&
          b === 'inputs' &&
          c &&
          c !== '*' &&
          c !== '?' &&
          unit.kind === 'workflow' &&
          unit.dispatch
        ) {
          return sym.input(unit.path, this.canonicalInput(unit, c));
        }
        return undefined;
      case 'secrets': {
        if (!a || a === '*' || a === '?' || unit.kind !== 'workflow') return undefined;
        const decl = unit.call ? lookup(unit.call.secrets, a) : undefined;
        return sym.secret(unit.path, decl?.name ?? a);
      }
      case 'vars':
        return a && a !== '?' && a !== '*' ? sym.var(a) : undefined;
      case 'matrix':
        return a && site.job && a !== '?' && a !== '*' ? sym.matrix(unit.path, site.job, a) : undefined;
      case 'needs': {
        if (unit.kind !== 'workflow' || !a || b !== 'outputs' || !c || c === '*' || c === '?')
          return undefined;
        const job = lookup(unit.jobs, a);
        if (!job) return undefined;
        return sym.jobOutput(unit.path, job.id, this.canonicalJobOutput(job, c));
      }
      case 'jobs': {
        if (unit.kind !== 'workflow' || site.field !== 'workflow.output' || !a || b !== 'outputs' || !c)
          return undefined;
        const job = lookup(unit.jobs, a);
        if (!job) return undefined;
        return sym.jobOutput(unit.path, job.id, this.canonicalJobOutput(job, c));
      }
      case 'steps': {
        if (!a || b !== 'outputs' || !c || c === '*' || c === '?') return undefined;
        const steps =
          unit.kind === 'action' ? unit.steps : site.job ? (unit.jobs[site.job]?.steps ?? []) : [];
        const step = steps.find((s) => s.id?.toLowerCase() === a.toLowerCase());
        if (!step?.id) return undefined;
        const action = this.actionOf(step);
        const name = (action && lookup(action.outputs, c)?.name) ?? c;
        return sym.stepOutput(unit.path, unit.kind === 'workflow' ? site.job : undefined, step.id, name);
      }
      case 'env': {
        if (!a || a === '*' || a === '?') return undefined;
        if (unit.kind === 'workflow' && site.job) {
          const job = unit.jobs[site.job];
          if (job && lookup(job.env, a)) return sym.env(unit.path, job.id, lookup(job.env, a)!.name);
        }
        if (unit.kind === 'workflow' && lookup(unit.env, a))
          return sym.env(unit.path, undefined, lookup(unit.env, a)!.name);
        return undefined;
      }
      default:
        return undefined;
    }
  }

  private canonicalInput(unit: UnitDecl, name: string): string {
    if (unit.kind === 'action') return lookup(unit.inputs, name)?.name ?? name;
    return (
      lookup(unit.call?.inputs ?? {}, name)?.name ?? lookup(unit.dispatch?.inputs ?? {}, name)?.name ?? name
    );
  }

  private canonicalJobOutput(job: JobDecl, name: string): string {
    const own = lookup(job.outputs, name);
    if (own) return own.name;
    const callee = this.calleeOf(job);
    return (callee?.call && lookup(callee.call.outputs, name)?.name) ?? name;
  }

  private indexSite(unit: UnitDecl, site: ExprSite) {
    this.sitesById.set(site.id, site);
    const sink = this.sinkOf(unit, site);
    for (const seg of site.segments) {
      for (const ref of seg.refs) {
        const symbol = this.resolveRef(unit, site, ref);
        if (!symbol) continue;
        if (!this.nodes.has(symbol)) {
          this.node({
            id: symbol,
            kind: ref.context === 'vars' ? 'var' : 'unresolved',
            label: `${ref.context}.${ref.path.join('.')}`,
            unit: unit.path,
          });
        }
        const usage: Usage = { symbol, site, ref, ...(sink ? { sink } : {}) };
        const list = this.usages.get(symbol);
        if (list) list.push(usage);
        else this.usages.set(symbol, [usage]);
        if (sink) this.edge({ from: symbol, to: sink, kind: 'flows', loc: ref.loc, siteId: site.id });
      }
    }
  }
}

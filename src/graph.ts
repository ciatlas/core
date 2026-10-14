import type { Json } from './expressions';
import type {
  ActionDecl,
  Binding,
  ExprSite,
  JobDecl,
  LocatedRef,
  OutputDecl,
  StepDecl,
  UnitDecl,
  UsesRef,
  WorkflowDecl,
} from './ir';
import { lookup } from './ir';
import { BUILTIN_SECRETS, refsOf } from './queries';
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
  /**
   * Set when the reference does not name the symbol: it reads a whole object (`toJSON(inputs)`, `needs.build.outputs`)
   * or indexes one with a computed key (`matrix[inputs.key]`), so it reads each member, this one among them (see
   * `ProjectIndex.readsOf`). Such a read does not single the member out: a rule about one particular member, such as
   * how a condition treats an empty input, can tell it apart from a read that names the member.
   */
  whole?: true;
}

/** One symbol a reference reads; `whole` when the reference does not name it (see `Usage.whole`). */
interface Read {
  symbol: string;
  whole: boolean;
  /** For a whole read, the reference that names the symbol, which labels its node when it has none yet. */
  member?: LocatedRef;
}

/** A path segment that names no key: the end of the path, a `*` filter or a `?` computed index. */
const computed = (s: string | undefined) => s === undefined || s === '*' || s === '?';

/** Whether a path segment names the property `key` (lowercase): GitHub looks properties up ignoring case. */
const isKey = (s: string | undefined, key: string) => s?.toLowerCase() === key;

/** The reads of each member of a whole object, once per symbol, as reads the reference does not name. */
function wholeReads(reads: Read[]): Read[] {
  const first = new Map<string, Read>();
  for (const r of reads) if (!first.has(r.symbol)) first.set(r.symbol, { ...r, whole: true });
  return [...first.values()];
}

/** The names of declared inputs, secrets or env variables, or of the keys a job passes, as written. */
const declaredNames = (decls: Record<string, { name: string }> | undefined) =>
  Object.values(decls ?? {}).map((d) => d.name);

/** The secret every workflow holds, in the spelling GitHub documents it by. */
const GITHUB_TOKEN = 'GITHUB_TOKEN';

/** The secrets a workflow reads by name, each spelling once, as written. */
function namedSecrets(wf: WorkflowDecl): string[] {
  const names = new Set<string>();
  for (const { ref } of refsOf(wf))
    if (ref.context === 'secrets' && !computed(ref.path[0])) names.add(ref.path[0]!);
  return [...names];
}

/** `names`, then each of `more` whose name, ignoring case, is not among them yet. */
function addNames(names: string[], more: string[]): string[] {
  const seen = new Set(names.map((n) => n.toLowerCase()));
  const added: string[] = [];
  for (const name of more) {
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    added.push(name);
  }
  return [...names, ...added];
}

/** The inputs a unit declares (a workflow's `workflow_call` and `workflow_dispatch` inputs of one name are one). */
function inputNames(unit: UnitDecl): string[] {
  if (unit.kind === 'action') return declaredNames(unit.inputs);
  return [...declaredNames(unit.call?.inputs), ...dispatchInputNames(unit)];
}

/** The inputs a workflow declares under `workflow_dispatch`. */
function dispatchInputNames(unit: UnitDecl): string[] {
  return unit.kind === 'workflow' ? declaredNames(unit.dispatch?.inputs) : [];
}

/**
 * The inputs of its own that `github.event.inputs` may hold at a site: a workflow's `workflow_dispatch` inputs, which
 * it holds when the workflow is dispatched. None in an action, whose `github` is its job's, nor at a site GitHub
 * evaluates only when the workflow is called, with the caller's `github` context: a `workflow_call` output's value, or
 * an input's default (a `workflow_dispatch` input's default allows no context).
 */
function eventInputsAt(unit: UnitDecl, site: ExprSite): Record<string, { name: string }> {
  if (unit.kind !== 'workflow' || onlyWhenCalled(site)) return {};
  return unit.dispatch?.inputs ?? {};
}

/** Whether GitHub evaluates a workflow's site only when the workflow is called (see `eventInputsAt`). */
const onlyWhenCalled = (site: ExprSite) => site.field === 'input.default' || site.field === 'workflow.output';

/**
 * The dispatch inputs a `github` reference reads without naming them, each as a reference naming it
 * (`github.event.inputs.<name>`). It may read them when each of its first two properties is `event` and `inputs`
 * (ignoring case), stands for any key (a `*` filter, a computed key) or is missing: a whole or computed `github`,
 * `github.event` or `github.event.inputs` reads every dispatch input it may hold at the site (see `eventInputsAt`), and
 * `github[x].inputs.<name>` the one it names. `undefined` for a reference that names its input outright (`resolveRef`
 * reads it) or can read none.
 */
function eventMemberRefs(unit: UnitDecl, site: ExprSite, ref: LocatedRef): LocatedRef[] | undefined {
  const [event, inputs, name] = ref.path;
  if (!(computed(event) || isKey(event, 'event')) || !(computed(inputs) || isKey(inputs, 'inputs')))
    return undefined;
  if (![event, inputs, name].some(computed)) return undefined;
  return declaredNames(eventInputsAt(unit, site))
    .filter((n) => computed(name) || isKey(n, name!.toLowerCase()))
    .map((n) => ({ ...ref, path: ['event', 'inputs', n, ...ref.path.slice(3)] }));
}

/** The job a site is in. */
function jobAt(unit: UnitDecl, site: ExprSite): JobDecl | undefined {
  return unit.kind === 'workflow' && site.job ? unit.jobs[site.job] : undefined;
}

/** The steps a site's `steps` context names: an action's, or those of the site's job. */
function stepsAt(unit: UnitDecl, site: ExprSite): StepDecl[] {
  return unit.kind === 'action' ? unit.steps : (jobAt(unit, site)?.steps ?? []);
}

/** The job in the symbol of a step output read at a site: the site's job in a workflow, none in an action. */
const stepJob = (unit: UnitDecl, site: ExprSite) => (unit.kind === 'workflow' ? site.job : undefined);

/**
 * The outputs among `names` that `<job or step>.<b>.<c>` reads: all of them, one by name, or none
 * (`needs.build.result`).
 */
function pickOutputs(names: string[], [, b, c]: string[]): string[] {
  if (computed(b)) return names;
  if (!isKey(b, 'outputs')) return [];
  if (computed(c)) return names;
  return names.filter((n) => n.toLowerCase() === c!.toLowerCase());
}

/** The keys of a job's matrix: its dimensions and the keys its `include` entries add. */
function matrixKeys(job: JobDecl | undefined): string[] {
  const m = job?.matrix;
  return m ? [...m.dims.map((d) => d.name), ...m.include.flatMap((inc) => Object.keys(inc.keyLocs))] : [];
}

/**
 * The key of a remote `uses:` reference (`owner/repo/path@ref`): GitHub matches the owner and repository in any letter
 * case, and the path and ref as written.
 */
export function remoteKey(raw: string): string {
  const [owner = '', repo = '', ...rest] = raw.trim().split('/');
  return [owner.toLowerCase(), repo.toLowerCase(), ...rest].join('/');
}

export interface Project {
  root: string;
  repository?: string;
  workflows: Map<string, WorkflowDecl>;
  actions: Map<string, ActionDecl>;
  /**
   * Units of other repositories, made from their interfaces (see `LoadProjectOptions.remotes`), by `remoteKey` of their
   * `uses:` reference. They are kept out of `workflows` and `actions`, so nothing that follows a call reaches them.
   */
  external?: Map<string, UnitDecl>;
  /** Files the requested paths name; every other file is loaded only as context. Empty = everything. */
  targets: Set<string>;
  /** Requested paths that do not exist (or lie outside the repository). */
  missingTargets?: string[];
  /** Requested paths that exist but are neither workflows nor action metadata. */
  ignoredTargets?: string[];
  /** Local `uses:` targets that do not exist. */
  missing: MissingTarget[];
  /**
   * Local `uses:` GitHub rejects, not loaded: job-level paths outside .github/workflows (`not-callable`), and `$/` with
   * an `@ref` suffix (`self-ref`).
   */
  invalidTargets?: {
    uses: UsesRef;
    from: string;
    job?: string;
    step?: number;
    reason?: 'not-callable' | 'self-ref';
  }[];
  /** Step `./path` references that lie outside this repository's files, so they are not verified (`workspace-action`). */
  unverified?: UnverifiedUse[];
  /** True when a requested path was the repository root itself. */
  wholeRepository?: boolean;
}

/** A local `uses:` whose target does not exist. */
export interface MissingTarget {
  uses: UsesRef;
  from: string;
  job?: string;
  step?: number;
  /**
   * The missing path, when it is not `uses.target`: a composite action's step that resolves in one caller's workspace
   * (its target) and not in another's (this).
   */
  target?: string;
  /**
   * The target is in this repository (and verified as the best guess), but not where the step's `./path` points:
   * nothing puts this repository at the workspace root (see `elsewhere`).
   */
  inRepository?: boolean;
  /** The checkout of this repository a step's `./path` was mapped through, when it is not the workspace root. */
  checkout?: { path: string; loc: Loc };
  /**
   * Set when no checkout of this repository is at the workspace root, where a step's `./path` points: the checkouts
   * of this repository elsewhere in the workspace (none when the job only checks out other repositories).
   */
  elsewhere?: { path: string; loc: Loc }[];
  /**
   * For a composite action's step that resolves differently for other callers: the steps leading here, from the
   * job that sets up the workspace in which the path is missing.
   */
  via?: WorkspaceCaller[];
}

/** A step that runs a composite action, so the action's steps resolve `./path` in that step's workspace. */
export interface WorkspaceCaller {
  /** The workflow or action the step is in. */
  from: string;
  job?: string;
  loc: Loc;
  /** The composite action it runs. */
  action: string;
}

/** Why a step's `./path` cannot be verified. */
export interface UnverifiedUse {
  uses: UsesRef;
  from: string;
  job?: string;
  step?: number;
  /**
   * `other-repository`: inside a checkout of another repository. `outside-workspace`: the path leaves the workspace.
   * `not-checked-out`: no checkout of this repository covers it (the job checks this repository out elsewhere, or to a
   * path computed at runtime), and it is not in one of this repository's top-level directories. `created-at-runtime`:
   * an earlier step's script writes there. `other-ref`: inside a checkout of this repository at another ref than the
   * running commit, which may hold it.
   */
  reason: 'other-repository' | 'outside-workspace' | 'not-checked-out' | 'created-at-runtime' | 'other-ref';
  /**
   * The checkout involved: the other repository's, one whose path or repository is computed at runtime, or this
   * repository's at another `ref`.
   */
  checkout?: { repository?: string; ref?: string; path: string; loc: Loc };
  /** The earlier step whose script writes there (`created-at-runtime`): the path it writes and the command. */
  writer?: { loc: Loc; path: string; command: string };
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

/** A declared secret of a workflow, by its declared case, or the name as written: secrets need no declaration. */
function resolveSecret(unit: UnitDecl, name: string): string | undefined {
  if (unit.kind !== 'workflow') return undefined;
  const decl = unit.call ? lookup(unit.call.secrets, name) : undefined;
  return sym.secret(unit.path, decl?.name ?? name);
}

/**
 * What sets a symbol's value, in the workflow or action `unit`: an expression `site`, or a plain YAML `value` (no
 * expression) at `loc`, such as `env: { MODE: fast }`; `job` names the job of a job's env or output.
 */
export type Definition =
  | { unit: UnitDecl; site: ExprSite }
  | { unit: UnitDecl; job?: string; value: Json; loc: Loc };

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
  private readonly definitions = new Map<string, Definition[]>();
  /** The secrets a whole `secrets` reads in each workflow, by path, once computed (see `secretNames`). */
  private readonly heldSecrets = new Map<string, string[]>();

  constructor(readonly project: Project) {
    for (const wf of project.workflows.values()) this.indexWorkflow(wf);
    for (const a of project.actions.values()) this.indexAction(a);
    for (const unit of this.units()) for (const site of unit.sites) this.indexSite(unit, site);
    for (const unit of this.units()) this.indexLiterals(unit);
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

  /** The reusable workflow a job calls. Workflows without `on.workflow_call` are not callable (see `targetOf`). */
  calleeOf(job: JobDecl): WorkflowDecl | undefined {
    const wf = this.targetOf(job);
    return wf?.call ? wf : undefined;
  }

  /** The local workflow file a job's `uses:` points at, reusable or not. */
  targetOf(job: JobDecl): WorkflowDecl | undefined {
    if (job.uses?.kind !== 'local-workflow' || !job.uses.target || job.uses.selfRef !== undefined)
      return undefined;
    if (!/^\.github\/workflows\/[^/]+\.ya?ml$/i.test(job.uses.target)) return undefined;
    return this.project.workflows.get(job.uses.target);
  }

  /**
   * The interface a job calls: its local reusable workflow, or the external unit of its remote one (see
   * `Project.external`). Only checks of what a caller passes and reads use it; `calleeOf` never returns an external unit.
   */
  // fallow-ignore-next-line unused-class-member -- API for flowpact's checks of remote calls (ciatlas/flowpact#152)
  interfaceOf(job: JobDecl): WorkflowDecl | undefined {
    if (job.uses?.kind !== 'remote-workflow') return this.calleeOf(job);
    const unit = this.project.external?.get(remoteKey(job.uses.raw));
    return unit?.kind === 'workflow' && unit.call ? unit : undefined;
  }

  /** The interface a step uses: its local action, or the external unit of its remote one (see `interfaceOf`). */
  // fallow-ignore-next-line unused-class-member -- API for flowpact's checks of remote actions (ciatlas/flowpact#152)
  actionInterfaceOf(step: StepDecl): ActionDecl | undefined {
    if (step.uses?.kind !== 'remote-action') return this.actionOf(step);
    const unit = this.project.external?.get(remoteKey(step.uses.raw));
    return unit?.kind === 'action' ? unit : undefined;
  }

  actionOf(step: StepDecl): ActionDecl | undefined {
    if (step.uses?.kind !== 'local-action' || !step.uses.target || step.uses.selfRef !== undefined)
      return undefined;
    return this.project.actions.get(step.uses.target);
  }

  usagesOf(symbol: string): Usage[] {
    return this.usages.get(symbol) ?? [];
  }

  /**
   * What sets a symbol's value. Expressions (see `sinkOf`): each caller's `with:` for a reusable workflow's input, each
   * `with:` of a step using an action for the action's input, a job's `outputs:` entry for its output, and so on. Plain
   * values of env variables and outputs. A caller's or step's plain value or omission of an input is not listed: `trace`
   * reads those from the calls.
   */
  definitionsOf(symbol: string): Definition[] {
    return this.definitions.get(symbol) ?? [];
  }

  outgoing(symbol: string, kind?: EdgeKind): GraphEdge[] {
    return this.edges.filter((e) => e.from === symbol && (!kind || e.kind === kind));
  }

  incoming(symbol: string, kind?: EdgeKind): GraphEdge[] {
    return this.edges.filter((e) => e.to === symbol && (!kind || e.kind === kind));
  }

  /** Serializable snapshot: every node and edge, in a stable order. */
  // fallow-ignore-next-line unused-class-member -- API; tests reach it via load()
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

  /**
   * Resolves a reference inside `site` to the symbol it reads, or `undefined` for runtime-only contexts. Property names
   * are compared ignoring case, as GitHub looks them up (`github.Event.Inputs.x`, `needs.build.Outputs.y`).
   */
  resolveRef(unit: UnitDecl, site: ExprSite, ref: LocatedRef): string | undefined {
    if (ref.context === 'github') return this.resolveEventInput(unit, site, ref.path);
    const [a] = ref.path;
    if (computed(a)) return undefined;
    switch (ref.context) {
      case 'inputs':
        return sym.input(unit.path, this.canonicalInput(unit, a!));
      case 'secrets':
        return resolveSecret(unit, a!);
      case 'vars':
        return sym.var(a!);
      case 'matrix':
        return site.job ? sym.matrix(unit.path, site.job, a!) : undefined;
      case 'env':
        return this.resolveEnv(unit, site, a!);
      default:
        return this.resolveOutput(unit, site, ref);
    }
  }

  /**
   * `github.event.inputs.<name>`: this workflow's own input only when it is dispatched directly, so only an input it
   * declares under `workflow_dispatch`. GitHub accepts no other input in a dispatch, and a workflow that is called gets
   * its caller's event, so a name only `workflow_call` declares, or none does, reads no input: it is the context. So
   * does any name in an input's default or a `workflow_call` output's value, which GitHub evaluates only when the
   * workflow is called (see `eventInputsAt`).
   */
  private resolveEventInput(unit: UnitDecl, site: ExprSite, [a, b, c]: string[]): string | undefined {
    if (!isKey(a, 'event') || !isKey(b, 'inputs') || computed(c)) return undefined;
    const input = lookup(eventInputsAt(unit, site), c!);
    return input && sym.input(unit.path, this.canonicalInput(unit, input.name));
  }

  /**
   * An env variable of the job or the workflow. A step's own `env:` shadows the job's and the workflow's in the rest of
   * the step (it is not a symbol); its values are evaluated before it applies, so they read the outer env.
   */
  private resolveEnv(unit: UnitDecl, site: ExprSite, name: string): string | undefined {
    const step = site.field === 'step.env' ? undefined : this.stepOf(unit, site);
    if (step && lookup(step.env, name)) return undefined;
    const job = jobAt(unit, site);
    const own = job && lookup(job.env, name);
    if (own) return sym.env(unit.path, job.id, own.name);
    const top = unit.kind === 'workflow' ? lookup(unit.env, name) : undefined;
    return top && sym.env(unit.path, undefined, top.name);
  }

  /**
   * `needs.<job>.outputs.<name>`, `jobs.<job>.outputs.<name>` (in a workflow output only) and
   * `steps.<id>.outputs.<name>`: the one output they name.
   */
  private resolveOutput(unit: UnitDecl, site: ExprSite, ref: LocatedRef): string | undefined {
    const [a, b, c] = ref.path;
    if (!isKey(b, 'outputs') || computed(c)) return undefined;
    switch (ref.context) {
      case 'steps':
        return this.resolveStepOutput(unit, site, a!, c!);
      case 'needs':
        return this.resolveJobOutput(unit, a!, c!);
      case 'jobs':
        return site.field === 'workflow.output' ? this.resolveJobOutput(unit, a!, c!) : undefined;
      default:
        return undefined;
    }
  }

  /** The output `name` of the job `id` of a workflow. */
  private resolveJobOutput(unit: UnitDecl, id: string, name: string): string | undefined {
    const job = unit.kind === 'workflow' ? lookup(unit.jobs, id) : undefined;
    return job && sym.jobOutput(unit.path, job.id, this.canonicalJobOutput(job, name));
  }

  /** The output `name` of the step `id` of the site's job, or of an action. */
  private resolveStepOutput(unit: UnitDecl, site: ExprSite, id: string, name: string): string | undefined {
    const step = stepsAt(unit, site).find((s) => s.id?.toLowerCase() === id.toLowerCase());
    if (!step?.id) return undefined;
    const action = this.actionOf(step);
    const output = (action && lookup(action.outputs, name)?.name) ?? name;
    return sym.stepOutput(unit.path, stepJob(unit, site), step.id, output);
  }

  /**
   * Every symbol a reference reads. Besides the single symbol of `resolveRef`, a reference that stops at a whole object
   * or indexes it with a computed key reads each member it may stand for:
   * - outputs: `toJSON(needs.build.outputs)`, `needs.build`, `steps.meta.outputs`, `needs.build.outputs[matrix.key]`,
   *   `toJSON(needs)` (every job the reading job needs) or `toJSON(steps)` (every step that ran before the reading
   *   step);
   * - `toJSON(inputs)` or `inputs[inputs.which]`: every input the unit declares;
   * - in a workflow that can be dispatched, whose `github.event` holds its `workflow_dispatch` inputs when it is
   *   dispatched: `toJSON(github)`, `github[x]`, `github.*`, `toJSON(github.event)`, `github.event[x]`,
   *   `github.event.*`, `toJSON(github.event.inputs)` or `github.event.inputs[x]` read every one of them, and
   *   `github[x].inputs.<name>` the one it names (see `eventMemberRefs`). A workflow that is called gets its caller's
   *   `github`, and an action its job's, so there they read none of the unit's inputs, nor in an input's default or a
   *   `workflow_call` output's value, which GitHub evaluates only when the workflow is called;
   * - `toJSON(matrix)` or `matrix[inputs.key]`: every key of the job's matrix;
   * - `toJSON(secrets)` or `secrets[inputs.name]`: every secret the workflow holds that the files name (see
   *   `secretNames`): those it declares under `workflow_call`, reads by name or is passed by name, `GITHUB_TOKEN`, and
   *   those callers that hand it every secret through `secrets: inherit` name;
   * - `toJSON(env)` or `env[inputs.name]`: every env variable in scope, a step's own read through their values.
   *
   * Variables are set in the repository's settings, not in its files, so a whole `vars` reads nothing. See
   * `Usage.whole`.
   */
  readsOf(unit: UnitDecl, site: ExprSite, ref: LocatedRef): string[] {
    return this.reads(unit, site, ref).map((r) => r.symbol);
  }

  private reads(unit: UnitDecl, site: ExprSite, ref: LocatedRef): Read[] {
    const one = this.resolveRef(unit, site, ref);
    if (one) return [{ symbol: one, whole: false }];
    const members = this.memberRefs(unit, site, ref);
    if (members) return wholeReads(members.flatMap((m) => this.memberReads(unit, site, m)));
    if (ref.context === 'env') return this.ownEnvReads(unit, site, ref);
    return this.outputReads(unit, site, ref).map((symbol) => ({ symbol, whole: true }));
  }

  /** What a reference naming one member of a whole object reads: the member, or what a step's own env value reads. */
  private memberReads(unit: UnitDecl, site: ExprSite, member: LocatedRef): Read[] {
    const one = this.resolveRef(unit, site, member);
    return one ? [{ symbol: one, whole: true, member }] : this.reads(unit, site, member);
  }

  /** A step's own env value is not a symbol: a read of it reads what the value reads (from the outer env). */
  private ownEnvReads(unit: UnitDecl, site: ExprSite, ref: LocatedRef): Read[] {
    const [a] = ref.path;
    if (computed(a) || site.field === 'step.env') return [];
    const own = lookup(this.stepOf(unit, site)?.env ?? {}, a!)?.site;
    return own ? own.segments.flatMap((s) => s.refs.flatMap((r) => this.reads(unit, own, r))) : [];
  }

  /**
   * A whole object or computed key of `inputs`, `matrix`, `secrets`, `env` or `github` as one reference per member,
   * each naming it (`toJSON(inputs)` → `inputs.a`, `inputs.b`, …; see `eventMemberRefs` for `github`), so each
   * resolves the way the name written out does. `undefined` for any other reference.
   */
  private memberRefs(unit: UnitDecl, site: ExprSite, ref: LocatedRef): LocatedRef[] | undefined {
    if (ref.context === 'github') return eventMemberRefs(unit, site, ref);
    if (!computed(ref.path[0])) return undefined;
    return this.memberNames(unit, site, ref.context)?.map((name) => ({
      ...ref,
      path: [name, ...ref.path.slice(1)],
    }));
  }

  /** The names a whole `inputs`, `matrix`, `secrets` or `env` holds at `site`; `undefined` for other contexts. */
  private memberNames(unit: UnitDecl, site: ExprSite, context: string): string[] | undefined {
    switch (context) {
      case 'inputs':
        return inputNames(unit);
      case 'matrix':
        return matrixKeys(jobAt(unit, site));
      case 'secrets':
        return unit.kind === 'workflow' ? this.secretNames(unit) : [];
      case 'env':
        return this.envNames(unit, site);
      default:
        return undefined;
    }
  }

  /**
   * The secrets a whole `secrets` holds in a workflow that the files name: each spelling of one it names itself (see
   * `ownSecretNames`), then those it gets through `secrets: inherit` that the callers handing them on name themselves
   * (see `inheritedSecretNames`), and `GITHUB_TOKEN`, which GitHub gives every workflow. GitHub looks secret names up
   * ignoring case, so those last two leave out a secret named before them in another case. A secret that neither the
   * workflow nor those callers name, such as a repository secret no file names or one only another of their callees
   * reads, has no symbol here.
   */
  private secretNames(wf: WorkflowDecl): string[] {
    const known = this.heldSecrets.get(wf.path);
    if (known) return known;
    const names = addNames(this.ownSecretNames(wf), [...this.inheritedSecretNames(wf), GITHUB_TOKEN]);
    this.heldSecrets.set(wf.path, names);
    return names;
  }

  /**
   * The secrets a workflow names itself, as written: those it declares under `workflow_call`, reads by name, or is
   * passed by name under a caller's `secrets:`. GitHub rejects a secret passed to a workflow that does not declare it,
   * but the files still send its value there (see `sinkOf`). A spelling of a declared secret is that secret (see
   * `resolveSecret`); any other is a symbol of its own, as for a reference.
   */
  private ownSecretNames(wf: WorkflowDecl): string[] {
    const passed = this.callersOf(wf.path).flatMap((c) => declaredNames(c.job.secrets));
    return [...declaredNames(wf.call?.secrets), ...namedSecrets(wf), ...passed];
  }

  /**
   * The secrets a workflow gets through `secrets: inherit` that the callers handing them on name themselves (see
   * `ownSecretNames`): each workflow that hands it every secret, directly or through others that do. Not
   * `GITHUB_TOKEN`, which `secrets: inherit` does not pass.
   */
  private inheritedSecretNames(wf: WorkflowDecl): string[] {
    return this.inheritingCallers(wf)
      .flatMap((caller) => this.ownSecretNames(caller))
      .filter((name) => !BUILTIN_SECRETS.has(name.toLowerCase()));
  }

  /** The workflows that hand `wf` every secret through `secrets: inherit`, and those that hand them every secret, … */
  private inheritingCallers(wf: WorkflowDecl): WorkflowDecl[] {
    const found = new Map<string, WorkflowDecl>([[wf.path, wf]]);
    // A Map's iteration visits the entries added while it runs: each caller found is searched in turn.
    for (const unit of found.values()) {
      for (const c of this.callersOf(unit.path))
        if (c.job.secretsInherit && !found.has(c.caller.path)) found.set(c.caller.path, c.caller);
    }
    found.delete(wf.path);
    return [...found.values()];
  }

  /** The env variables in scope at a site: the step's own, the job's and the workflow's. */
  private envNames(unit: UnitDecl, site: ExprSite): string[] {
    // A step's own env applies to the rest of the step, not to its own values (see `resolveRef`).
    const step = site.field === 'step.env' ? undefined : this.stepOf(unit, site);
    const workflow = unit.kind === 'workflow' ? unit.env : undefined;
    return [
      ...declaredNames(step?.env),
      ...declaredNames(jobAt(unit, site)?.env),
      ...declaredNames(workflow),
    ];
  }

  /**
   * The job and step outputs a `needs`, `jobs` or `steps` reference reads when it names no single output: every output
   * of a whole object or computed key, or the one named output of every job or step a computed key may stand for.
   */
  private outputReads(unit: UnitDecl, site: ExprSite, ref: LocatedRef): string[] {
    switch (ref.context) {
      case 'needs':
      case 'jobs': {
        if (unit.kind !== 'workflow') return [];
        if (ref.context === 'jobs' && site.field !== 'workflow.output') return [];
        return this.jobsRead(unit, site, ref).flatMap((job) =>
          pickOutputs(this.jobOutputNames(job), ref.path).map((n) => sym.jobOutput(unit.path, job.id, n)),
        );
      }
      case 'steps':
        return this.stepOutputReads(unit, site, ref);
      default:
        return [];
    }
  }

  /** The jobs a `needs` or `jobs` reference reads: the one it names, or each one a computed key may stand for. */
  private jobsRead(wf: WorkflowDecl, site: ExprSite, ref: LocatedRef): JobDecl[] {
    const [a] = ref.path;
    if (!computed(a)) {
      const job = lookup(wf.jobs, a!);
      return job ? [job] : [];
    }
    if (ref.context === 'jobs') return Object.values(wf.jobs);
    // The `needs` context holds the jobs the reading job depends on directly.
    const reader = site.job ? wf.jobs[site.job] : undefined;
    return (reader?.needs ?? []).flatMap((n) => lookup(wf.jobs, n.id) ?? []);
  }

  /**
   * The step outputs a `steps` reference reads: of the step it names, or of each step a computed key may stand for
   * (from a step, only the steps before it), every output or the one it names (see `pickOutputs`).
   */
  private stepOutputReads(unit: UnitDecl, site: ExprSite, ref: LocatedRef): string[] {
    const [a] = ref.path;
    const steps = stepsAt(unit, site);
    // In a step, the `steps` context holds only the steps that ran before it; job and action outputs see them all.
    const named = computed(a)
      ? steps.filter((s) => site.step === undefined || s.index < site.step)
      : steps.filter((s) => s.id?.toLowerCase() === a!.toLowerCase());
    const job = stepJob(unit, site);
    return named.flatMap((step) => {
      const action = this.actionOf(step);
      if (!step.id || !action) return [];
      return pickOutputs(Object.keys(action.outputs), ref.path).map((n) =>
        sym.stepOutput(unit.path, job, step.id!, n),
      );
    });
  }

  /** Output names of a job: its own `outputs:`, or the callee's workflow outputs for a reusable call. */
  jobOutputNames(job: JobDecl): string[] {
    const callee = this.calleeOf(job);
    return Object.keys(callee ? (callee.call?.outputs ?? {}) : job.outputs);
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

  private define(symbol: string, def: Definition) {
    const list = this.definitions.get(symbol);
    if (list) list.push(def);
    else this.definitions.set(symbol, [def]);
  }

  /** Env variables and outputs written as plain values (an expression is a site, indexed by `indexSite`). */
  private indexLiterals(unit: UnitDecl) {
    const u = unit.path;
    if (unit.kind === 'action') {
      this.literalOutputs(unit, unit.outputs, (name) => sym.output(u, name));
      return;
    }
    this.literalEnv(unit, undefined, unit.env);
    this.literalOutputs(unit, unit.call?.outputs ?? {}, (name) => sym.output(u, name));
    for (const job of Object.values(unit.jobs)) {
      this.literalEnv(unit, job.id, job.env);
      this.literalOutputs(unit, job.outputs, (name) => sym.jobOutput(u, job.id, name), job.id);
    }
  }

  private literalEnv(unit: UnitDecl, job: string | undefined, env: Record<string, Binding>) {
    for (const e of Object.values(env)) {
      if (!e.site)
        this.define(sym.env(unit.path, job, e.name), { unit, job, value: e.value, loc: e.valueLoc });
    }
  }

  private literalOutputs(
    unit: UnitDecl,
    outputs: Record<string, OutputDecl>,
    symbolOf: (name: string) => string,
    job?: string,
  ) {
    for (const o of Object.values(outputs)) {
      if (!o.site && o.value !== undefined)
        this.define(symbolOf(o.name), { unit, job, value: o.value, loc: o.loc });
    }
  }

  private indexSite(unit: UnitDecl, site: ExprSite) {
    this.sitesById.set(site.id, site);
    const sink = this.sinkOf(unit, site);
    if (sink) this.define(sink, { unit, site });
    for (const seg of site.segments) {
      for (const ref of seg.refs) {
        for (const read of this.reads(unit, site, ref)) this.addUsage(unit, site, ref, read, sink);
      }
    }
  }

  private addUsage(unit: UnitDecl, site: ExprSite, ref: LocatedRef, read: Read, sink: string | undefined) {
    const { symbol } = read;
    if (!this.nodes.has(symbol)) {
      // A secret only a whole read reads is labelled by its name (`secrets.GITHUB_TOKEN`), not by `secrets`.
      const named = read.member ?? ref;
      this.node({
        id: symbol,
        kind: named.context === 'vars' ? 'var' : 'unresolved',
        label: `${named.context}.${named.path.join('.')}`,
        unit: unit.path,
      });
    }
    const usage: Usage = {
      symbol,
      site,
      ref,
      ...(sink ? { sink } : {}),
      ...(read.whole ? { whole: true } : {}),
    };
    const list = this.usages.get(symbol);
    if (list) list.push(usage);
    else this.usages.set(symbol, [usage]);
    if (sink) this.edge({ from: symbol, to: sink, kind: 'flows', loc: ref.loc, siteId: site.id });
  }
}

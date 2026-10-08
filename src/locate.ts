import { type ProjectIndex, sym } from './graph';
import {
  type Binding,
  type ExprSite,
  type InputDecl,
  type JobDecl,
  type LocatedRef,
  lookup,
  type OutputDecl,
  type SecretDecl,
  type StepDecl,
  type UnitDecl,
  type UsesRef,
} from './ir';
import { compareLoc, type Loc } from './source';

/** What declares a symbol: the key it is defined under, and the IR behind it (for hover text). */
export type Declaration =
  | { kind: 'input'; unit: string; loc: Loc; decl: InputDecl }
  | { kind: 'secret'; unit: string; loc: Loc; decl: SecretDecl }
  /** Workflow, action and job outputs. */
  | { kind: 'output'; unit: string; loc: Loc; decl: OutputDecl }
  | { kind: 'job'; unit: string; loc: Loc; decl: JobDecl }
  | { kind: 'env'; unit: string; loc: Loc; decl: Binding }
  /** A matrix dimension or a key of an `include` entry. */
  | { kind: 'matrix'; unit: string; loc: Loc; job: JobDecl; key: string }
  /** A step whose outputs are written by its script or by a remote action, so no output is declared. */
  | { kind: 'step'; unit: string; loc: Loc; decl: StepDecl }
  /** A workflow or action file (what `uses:` points at). */
  | { kind: 'unit'; unit: string; loc: Loc; decl: UnitDecl };

export type OccurrenceRole =
  /** The key that declares the symbol (`inputs: { name: … }`, a job id, a matrix key). */
  | 'declaration'
  /** An expression reads it (`${{ inputs.name }}`). */
  | 'read'
  /** A caller sets it: a `with:` or `secrets:` key passed to a local workflow or action. */
  | 'binding'
  /** A `needs:` entry naming a job. */
  | 'needs'
  /** A `uses:` value naming a workflow or action. */
  | 'uses';

/** One place where a symbol's name is written. */
export interface Occurrence {
  symbol: string;
  loc: Loc;
  role: OccurrenceRole;
}

const fileStart = (file: string): Loc => ({ file, line: 1, column: 1, endLine: 1, endColumn: 1 });

/** Whether position a comes before or at position b. */
const atOrBefore = (aLine: number, aCol: number, bLine: number, bCol: number) =>
  aLine < bLine || (aLine === bLine && aCol <= bCol);

const sameLoc = (a: Loc, b: Loc) =>
  compareLoc(a, b) === 0 && a.endLine === b.endLine && a.endColumn === b.endColumn;

/**
 * Finds symbols by source position, for editors: which symbol a name in a file stands for, where that symbol is
 * declared and where else it occurs. Built once per analysis from the {@link ProjectIndex}.
 */
export class SymbolLocator {
  private readonly byFile = new Map<string, Occurrence[]>();
  private readonly bySymbol = new Map<string, Occurrence[]>();
  private readonly decls = new Map<string, Declaration[]>();

  constructor(readonly index: ProjectIndex) {
    for (const unit of index.units()) this.indexUnit(unit);
    for (const list of this.bySymbol.values()) list.sort((a, b) => compareLoc(a.loc, b.loc));
  }

  /**
   * The innermost occurrence at a position (1-based, like {@link Loc}). A cursor right after a name still finds it,
   * unless another name starts there.
   */
  at(file: string, line: number, column: number): Occurrence | undefined {
    let inside: Occurrence | undefined;
    let touching: Occurrence | undefined;
    const smaller = (a: Occurrence, b: Occurrence | undefined) =>
      !b ||
      a.loc.endLine - a.loc.line < b.loc.endLine - b.loc.line ||
      (a.loc.endLine - a.loc.line === b.loc.endLine - b.loc.line &&
        a.loc.endColumn - a.loc.column < b.loc.endColumn - b.loc.column);
    for (const o of this.byFile.get(file) ?? []) {
      const { loc } = o;
      if (!atOrBefore(loc.line, loc.column, line, column)) continue;
      if (!atOrBefore(line, column, loc.endLine, loc.endColumn)) continue;
      const atEnd = line === loc.endLine && column === loc.endColumn;
      if (atEnd) {
        if (smaller(o, touching)) touching = o;
      } else if (smaller(o, inside)) {
        inside = o;
      }
    }
    return inside ?? touching;
  }

  /** Where the symbol is declared; empty for runtime values (`secrets.GITHUB_TOKEN`, `vars.*`) and remote units. */
  declarations(symbol: string): Declaration[] {
    return this.decls.get(symbol) ?? [];
  }

  /** Every place the symbol's name is written, declarations included, in file order. */
  occurrences(symbol: string): Occurrence[] {
    return this.bySymbol.get(symbol) ?? [];
  }

  private add(symbol: string, loc: Loc, role: OccurrenceRole) {
    const list = this.bySymbol.get(symbol) ?? [];
    if (list.some((o) => o.role === role && sameLoc(o.loc, loc))) return;
    const o = { symbol, loc, role };
    list.push(o);
    this.bySymbol.set(symbol, list);
    const inFile = this.byFile.get(loc.file) ?? [];
    inFile.push(o);
    this.byFile.set(loc.file, inFile);
  }

  /** Records a declaration; its key is an occurrence too when it names the symbol (callee outputs do not). */
  private declare(symbol: string, d: Declaration, occurrence = true) {
    const list = this.decls.get(symbol) ?? [];
    if (!list.some((x) => x.kind === d.kind && sameLoc(x.loc, d.loc))) list.push(d);
    this.decls.set(symbol, list);
    if (occurrence) this.add(symbol, d.loc, 'declaration');
  }

  private indexUnit(unit: UnitDecl) {
    const u = unit.path;
    this.declare(u, { kind: 'unit', unit: u, loc: fileStart(unit.file), decl: unit }, false);
    if (unit.kind === 'workflow') {
      const inputs = [
        ...Object.values(unit.call?.inputs ?? {}),
        ...Object.values(unit.dispatch?.inputs ?? {}),
      ];
      for (const i of inputs)
        this.declare(sym.input(u, i.name), { kind: 'input', unit: u, loc: i.loc, decl: i });
      for (const s of Object.values(unit.call?.secrets ?? {}))
        this.declare(sym.secret(u, s.name), { kind: 'secret', unit: u, loc: s.loc, decl: s });
      for (const o of Object.values(unit.call?.outputs ?? {}))
        this.declare(sym.output(u, o.name), { kind: 'output', unit: u, loc: o.loc, decl: o });
      for (const e of Object.values(unit.env))
        this.declare(sym.env(u, undefined, e.name), { kind: 'env', unit: u, loc: e.loc, decl: e });
      for (const job of Object.values(unit.jobs)) this.indexJob(unit, job);
    } else {
      for (const i of Object.values(unit.inputs))
        this.declare(sym.input(u, i.name), { kind: 'input', unit: u, loc: i.loc, decl: i });
      for (const o of Object.values(unit.outputs))
        this.declare(sym.output(u, o.name), { kind: 'output', unit: u, loc: o.loc, decl: o });
      for (const step of unit.steps) this.indexStep(unit, undefined, step);
    }
    for (const site of unit.sites)
      for (const seg of site.segments) for (const ref of seg.refs) this.indexRef(unit, site, ref);
  }

  private indexJob(wf: Extract<UnitDecl, { kind: 'workflow' }>, job: JobDecl) {
    const u = wf.path;
    this.declare(sym.job(u, job.id), { kind: 'job', unit: u, loc: job.loc, decl: job });
    for (const n of job.needs) {
      const target = lookup(wf.jobs, n.id);
      if (target) this.add(sym.job(u, target.id), n.loc, 'needs');
    }
    for (const o of Object.values(job.outputs))
      this.declare(sym.jobOutput(u, job.id, o.name), { kind: 'output', unit: u, loc: o.loc, decl: o });
    for (const e of Object.values(job.env))
      this.declare(sym.env(u, job.id, e.name), { kind: 'env', unit: u, loc: e.loc, decl: e });
    for (const d of job.matrix?.dims ?? [])
      this.declare(sym.matrix(u, job.id, d.name), { kind: 'matrix', unit: u, loc: d.loc, job, key: d.name });
    for (const inc of job.matrix?.include ?? [])
      for (const [key, loc] of Object.entries(inc.keyLocs))
        this.declare(sym.matrix(u, job.id, key), { kind: 'matrix', unit: u, loc, job, key });

    if (job.uses) {
      const target = this.index.targetOf(job);
      if (target) this.add(target.path, job.uses.loc, 'uses');
      else this.addRemote(job.uses);
      const callee = this.index.calleeOf(job);
      if (callee?.call) {
        for (const b of Object.values(job.with)) {
          const decl = lookup(callee.call.inputs, b.name);
          if (decl) this.add(sym.input(callee.path, decl.name), b.loc, 'binding');
        }
        for (const b of Object.values(job.secrets)) {
          const decl = lookup(callee.call.secrets, b.name);
          if (decl) this.add(sym.secret(callee.path, decl.name), b.loc, 'binding');
        }
        // A calling job's outputs are the callee's workflow outputs.
        for (const o of Object.values(callee.call.outputs))
          this.declare(
            sym.jobOutput(u, job.id, o.name),
            { kind: 'output', unit: callee.path, loc: o.loc, decl: o },
            false,
          );
      }
    }
    for (const step of job.steps) this.indexStep(wf, job, step);
  }

  private indexStep(unit: UnitDecl, job: JobDecl | undefined, step: StepDecl) {
    if (!step.uses) return;
    const action = this.index.actionOf(step);
    if (!action) {
      this.addRemote(step.uses);
      return;
    }
    this.add(action.path, step.uses.loc, 'uses');
    for (const b of Object.values(step.with)) {
      const decl = lookup(action.inputs, b.name);
      if (decl) this.add(sym.input(action.path, decl.name), b.loc, 'binding');
    }
    if (step.id)
      for (const o of Object.values(action.outputs))
        this.declare(
          sym.stepOutput(unit.path, job?.id, step.id, o.name),
          { kind: 'output', unit: action.path, loc: o.loc, decl: o },
          false,
        );
  }

  private addRemote(uses: UsesRef) {
    if (uses.kind === 'remote-workflow' || uses.kind === 'remote-action')
      this.add(sym.remote(uses.raw), uses.loc, 'uses');
  }

  private indexRef(unit: UnitDecl, site: ExprSite, ref: LocatedRef) {
    const symbol = this.index.resolveRef(unit, site, ref) ?? this.jobOf(unit, site, ref);
    if (!symbol) return;
    this.add(symbol, ref.loc, 'read');
    // Outputs of a `run:` step (or a remote action) are not declared anywhere; the step is the closest definition.
    if (ref.context === 'steps') {
      const steps = unit.kind === 'action' ? unit.steps : site.job ? (unit.jobs[site.job]?.steps ?? []) : [];
      const step = steps.find((s) => s.id?.toLowerCase() === ref.path[0]?.toLowerCase());
      if (step?.idLoc && !this.index.actionOf(step))
        this.declare(symbol, { kind: 'step', unit: unit.path, loc: step.idLoc, decl: step }, false);
    }
  }

  /** `needs.<job>.result` and similar reads that name a job but no output. */
  private jobOf(unit: UnitDecl, site: ExprSite, ref: LocatedRef): string | undefined {
    if (unit.kind !== 'workflow' || !ref.path[0]) return undefined;
    if (ref.context !== 'needs' && !(ref.context === 'jobs' && site.field === 'workflow.output'))
      return undefined;
    const job = lookup(unit.jobs, ref.path[0]);
    return job ? sym.job(unit.path, job.id) : undefined;
  }
}

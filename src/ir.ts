import type { ExprRef, Json, ParsedExpression } from './expressions';
import type { Loc, SourceFile } from './source';

/** Where an expression appears, so rules can reason about scope and meaning. */
export type SiteField =
  | 'workflow.env'
  | 'workflow.output'
  | 'workflow.other'
  | 'input.default'
  | 'job.if'
  /** `jobs.<id>.name`, when it contains an expression (it decides the job's check-run name). */
  | 'job.name'
  | 'job.with'
  | 'job.secrets'
  | 'job.env'
  | 'job.output'
  | 'job.strategy'
  | 'job.other'
  | 'step.if'
  | 'step.with'
  | 'step.env'
  | 'step.run'
  | 'step.other'
  | 'action.output'
  /** `runs.pre-if` / `runs.post-if` of a JavaScript action. */
  | 'action.runs-if'
  | 'other';

export interface LocatedRef extends ExprRef {
  loc: Loc;
}

export interface ExprSegment {
  expr: ParsedExpression;
  /** Location of the inner expression text. */
  loc: Loc;
  refs: LocatedRef[];
}

/** A YAML scalar that contains (or, for `if:`, is) an expression. */
export interface ExprSite {
  id: number;
  file: string;
  ownerPath: string;
  field: SiteField;
  job?: string;
  step?: number;
  /** The key for keyed fields (`with`, `env`, `outputs`, `secrets`). */
  key?: string;
  /** YAML path from the document root, for diagnostics. */
  yamlPath: (string | number)[];
  text: string;
  loc: Loc;
  isCondition: boolean;
  segments: ExprSegment[];
}

export interface InputDecl {
  name: string;
  type?: string;
  required: boolean;
  hasDefault: boolean;
  default?: Json;
  description?: string;
  options?: string[];
  loc: Loc;
}

export interface SecretDecl {
  name: string;
  required: boolean;
  description?: string;
  loc: Loc;
}

export interface OutputDecl {
  name: string;
  description?: string;
  loc: Loc;
  value?: Json;
  site?: ExprSite;
}

/** A `key: value` passed somewhere: `with`, `secrets`, `env`. */
export interface Binding {
  name: string;
  loc: Loc;
  valueLoc: Loc;
  value: Json;
  site?: ExprSite;
}

export type UsesKind = 'local-workflow' | 'remote-workflow' | 'local-action' | 'remote-action' | 'docker';

export interface UsesRef {
  raw: string;
  loc: Loc;
  kind: UsesKind;
  /** Repo-relative target for local references (workflow file or action directory). */
  target?: string;
  /** Set when a remote reference points at this same repository and was resolved locally. */
  sameRepoRef?: string;
}

export interface MatrixEntry {
  loc: Loc;
  values: Record<string, Json>;
  /** Keys whose value is an expression that cannot be resolved statically. */
  dynamicKeys: string[];
  keyLocs: Record<string, Loc>;
}

export interface MatrixDim {
  name: string;
  loc: Loc;
  /** `null` when the whole dimension is an expression. */
  values: Json[] | null;
  /** Indexes of values that are expressions (the key exists, the value is unknown). */
  unknownIndexes: number[];
}

export interface MatrixDecl {
  loc: Loc;
  /** True when `matrix:` itself (or `include`/`exclude`) is a single expression such as `fromJSON(...)`. */
  dynamic: boolean;
  dynamicSite?: ExprSite;
  dims: MatrixDim[];
  include: MatrixEntry[];
  exclude: MatrixEntry[];
  includeDynamic: boolean;
  excludeDynamic: boolean;
}

export interface StepDecl {
  index: number;
  id?: string;
  idLoc?: Loc;
  name?: string;
  loc: Loc;
  uses?: UsesRef;
  run?: string;
  runLoc?: Loc;
  with: Record<string, Binding>;
  env: Record<string, Binding>;
  ifSite?: ExprSite;
  /** Output names an inline `run` script writes to `$GITHUB_OUTPUT`; `dynamic` when it cannot tell. */
  writesOutputs: { names: string[]; dynamic: boolean; mentions: boolean };
  writesEnv: { names: string[]; dynamic: boolean };
}

/** `permissions:` of a workflow or job: a shorthand, or a scope → level map (`{}` grants nothing). */
export type PermissionsDecl = 'read-all' | 'write-all' | Record<string, 'read' | 'write' | 'none'>;

export interface JobDecl {
  id: string;
  loc: Loc;
  name?: string;
  /** The `name:` scalar when it contains `${{ }}` (evaluated per matrix combination for check-run names). */
  nameSite?: ExprSite;
  nameLoc?: Loc;
  permissions?: PermissionsDecl;
  /** `if:` written as a YAML boolean (`if: false`), which has no expression site. */
  ifValue?: boolean;
  needs: { id: string; loc: Loc }[];
  ifSite?: ExprSite;
  uses?: UsesRef;
  with: Record<string, Binding>;
  secrets: Record<string, Binding>;
  secretsInherit: boolean;
  secretsLoc?: Loc;
  env: Record<string, Binding>;
  outputs: Record<string, OutputDecl>;
  matrix?: MatrixDecl;
  steps: StepDecl[];
}

export interface Diagnostic {
  message: string;
  loc: Loc;
  /** `context`: a known context or function used where GitHub does not allow it. */
  kind?: 'context';
  /** Start of the YAML scalar as GitHub's parser reports it (1-based). */
  at?: { line: number; column: number };
}

interface BaseDecl {
  path: string;
  file: string;
  name?: string;
  source: SourceFile;
  sites: ExprSite[];
  parseErrors: Diagnostic[];
  schemaErrors: Diagnostic[];
}

export interface WorkflowDecl extends BaseDecl {
  kind: 'workflow';
  triggers: string[];
  call?: {
    loc: Loc;
    inputs: Record<string, InputDecl>;
    secrets: Record<string, SecretDecl>;
    outputs: Record<string, OutputDecl>;
  };
  dispatch?: { loc: Loc; inputs: Record<string, InputDecl> };
  env: Record<string, Binding>;
  permissions?: PermissionsDecl;
  jobs: Record<string, JobDecl>;
}

export interface ActionDecl extends BaseDecl {
  kind: 'action';
  using?: string;
  inputs: Record<string, InputDecl>;
  outputs: Record<string, OutputDecl>;
  steps: StepDecl[];
}

export type UnitDecl = WorkflowDecl | ActionDecl;

/** Case-insensitive lookup, matching how GitHub resolves context property names. */
export function lookup<T>(rec: Record<string, T>, key: string): T | undefined {
  if (key in rec) return rec[key];
  const lower = key.toLowerCase();
  for (const k of Object.keys(rec)) if (k.toLowerCase() === lower) return rec[k];
  return undefined;
}

export function hasKey(rec: Record<string, unknown>, key: string): boolean {
  return lookup(rec, key) !== undefined;
}

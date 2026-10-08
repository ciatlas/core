/** Impact mode: grading changes to published units, the declared impact and the verdict. */
import {
  analyze,
  DEFAULT_IMPACT_POLICY,
  type DeclaredInput,
  type ImpactChange,
  impactChanges,
  impactVerdict,
  levelFromTitle,
  levelFromVersions,
  memoryFileSystem,
  type ProjectIndex,
  parseConfig,
} from '@flowpact/core';
import { describe, expect, it } from 'vitest';
import { codes, WF } from './helpers';

const index = (files: Record<string, string>, publish?: string[]): ProjectIndex =>
  analyze({
    root: '/v',
    fs: memoryFileSystem(files),
    validateSchema: false,
    only: [],
    repository: 'a/b',
    ...(publish ? { config: parseConfig({ impact: { publish } }) } : {}),
  }).index;

const reusable = (body: string, inputs = '') =>
  `on:\n  workflow_call:\n${inputs || '    inputs: {}\n'}jobs:\n${body}`;
const job = (id: string, extra = '') =>
  `  ${id}:\n${extra}    runs-on: ubuntu-latest\n    steps: [{ run: 'true' }]\n`;

function changes(
  before: Record<string, string>,
  after: Record<string, string>,
  publish?: string[],
): ImpactChange[] {
  return impactChanges(index(before, publish), index(after, publish), publish ? { publish } : {});
}
const summary = (cs: ImpactChange[]) => cs.map((c) => `${c.level}${c.certain ? '' : '?'} ${c.message}`);

describe('check names of published reusable workflows', () => {
  it('a renamed job is major, reported as a rename at the job', () => {
    const cs = changes(
      { [`${WF}/r.yml`]: reusable(job('test', '    name: Test\n')) },
      { [`${WF}/r.yml`]: reusable(job('test', '    name: Unit tests\n')) },
    );
    expect(summary(cs)).toEqual([
      'major check "… / Test" is now "… / Unit tests"; consumers that require the old name wait forever',
    ]);
    expect(cs[0]!.loc.line).toBe(6);
  });

  it('removing a matrix value is major, adding one is minor', () => {
    const mx = (values: string) => job('t', `    strategy:\n      matrix:\n        node: [${values}]\n`);
    expect(
      summary(
        changes({ [`${WF}/r.yml`]: reusable(mx('20, 22')) }, { [`${WF}/r.yml`]: reusable(mx('22, 24')) }),
      ),
    ).toEqual([
      'major check "… / t (20)" no longer reported; consumers that require it wait forever',
      'minor new check "… / t (24)"',
    ]);
    expect(
      summary(changes({ [`${WF}/r.yml`]: reusable(mx('22')) }, { [`${WF}/r.yml`]: reusable(mx('22, 24')) })),
    ).toEqual(['minor new check "… / t (24)"']);
  });

  it('a renamed literal part is certain even when the rest of the name is not', () => {
    const cs = changes(
      { [`${WF}/r.yml`]: reusable(job('t', '    name: T ${{ vars.X }}\n')) },
      { [`${WF}/r.yml`]: reusable(job('t', '    name: U ${{ vars.X }}\n')) },
    );
    expect(cs.map((c) => [c.level, c.certain])).toEqual([['major', true]]);
  });

  it('ignores workflows that are not published', () => {
    expect(
      changes(
        { [`${WF}/ci.yml`]: `on: push\njobs:\n${job('test', '    name: Test\n')}` },
        { [`${WF}/ci.yml`]: `on: push\njobs:\n${job('test', '    name: Unit tests\n')}` },
      ),
    ).toEqual([]);
  });
});

describe('interfaces, units, permissions and runtimes', () => {
  const inputs = (s: string) => `    inputs:\n${s}`;
  it('grades workflow_call interface changes', () => {
    const before = {
      [`${WF}/r.yml`]: reusable(
        job('t'),
        inputs("      a: { type: string, default: 'x' }\n      b: { type: string }\n"),
      ),
    };
    const after = {
      [`${WF}/r.yml`]: reusable(
        job('t'),
        inputs(
          "      a: { type: string, default: 'y' }\n      c: { type: string }\n      d: { type: string, required: true }\n",
        ),
      ),
    };
    expect(summary(changes(before, after)).sort()).toEqual(
      [
        'major input "b" was removed — callers that pass it will fail',
        'major input "d" was added and must be passed — existing callers do not pass it',
        'minor input "a" default changed from "x" to "y"',
        'minor input "c" was added',
      ].sort(),
    );
  });

  it('a removed or no longer callable unit is major, a new one minor', () => {
    expect(summary(changes({ [`${WF}/r.yml`]: reusable(job('t')) }, {}))).toEqual([
      'major reusable workflow .github/workflows/r.yml was removed or moved; consumers that reference it fail',
    ]);
    expect(
      summary(
        changes({ [`${WF}/r.yml`]: reusable(job('t')) }, { [`${WF}/r.yml`]: `on: push\njobs:\n${job('t')}` }),
      ),
    ).toEqual(['major .github/workflows/r.yml can no longer be called (no workflow_call)']);
    expect(summary(changes({}, { [`${WF}/r.yml`]: reusable(job('t')) }))).toEqual([
      'minor new reusable workflow .github/workflows/r.yml',
    ]);
  });

  it('widened permissions are major; narrowed ones are not graded', () => {
    const perms = (p: string) => reusable(job('t', `    permissions: ${p}\n`));
    expect(
      summary(
        changes(
          { [`${WF}/r.yml`]: perms('{ contents: read }') },
          { [`${WF}/r.yml`]: perms('{ contents: write }') },
        ),
      ),
    ).toEqual([
      'major jobs.t now requests contents: write; callers that grant less fail when the run starts',
    ]);
    expect(
      changes(
        { [`${WF}/r.yml`]: perms('{ contents: write }') },
        { [`${WF}/r.yml`]: perms('{ contents: read }') },
      ),
    ).toEqual([]);
    expect(
      summary(
        changes({ [`${WF}/r.yml`]: reusable(job('t')) }, { [`${WF}/r.yml`]: perms('{ id-token: write }') }),
      ),
    ).toEqual([
      'major? jobs.t now requests id-token: write; callers that grant less fail when the run starts',
    ]);
  });

  it('grades published actions: runtime and new third-party actions; internal actions are ignored', () => {
    const action = (using: string, steps = '') =>
      `name: a\ndescription: d\nruns:\n  using: ${using}\n${using === 'composite' ? `  steps:\n${steps || '    - run: x\n      shell: bash\n'}` : '  main: index.js\n'}`;
    expect(summary(changes({ 'action.yml': action('node20') }, { 'action.yml': action('node24') }))).toEqual([
      'major runs.using changed from node20 to node24; runners or GHES versions without it cannot run the action',
    ]);
    expect(
      summary(
        changes(
          { 'tools/a/action.yml': action('composite') },
          { 'tools/a/action.yml': action('composite', '    - uses: some/thing@v1\n') },
          ['tools/*'],
        ),
      ),
    ).toEqual([
      'minor now uses some/thing; consumers whose organization only allows listed actions (or requires SHA pinning) must allow it',
    ]);
    expect(
      changes(
        { '.github/actions/a/action.yml': action('node20') },
        { '.github/actions/a/action.yml': action('node24') },
      ),
    ).toEqual([]);
    expect(
      changes(
        { '.github/actions/a/action.yml': action('node20') },
        { '.github/actions/a/action.yml': action('node24') },
        ['.github/actions/**'],
      ),
    ).toHaveLength(1);
  });
});

const pre = (bumpMinorPreMajor: boolean, bumpPatchForMinorPreMajor = false) => ({
  bumpMinorPreMajor,
  bumpPatchForMinorPreMajor,
});

describe('declared impact', () => {
  it.each([
    ['feat!: drop the old input', 'major'],
    ['fix(ci)!: rename the check', 'major'],
    ['feat: add an input', 'minor'],
    ['fix: typo', 'patch'],
    ['perf: faster', 'patch'],
    ['chore: tidy', 'none'],
    ['Update ci.yml', undefined],
  ])('reads %j as %s', (title, level) => {
    expect(levelFromTitle(title, DEFAULT_IMPACT_POLICY.types)).toBe(level);
  });

  it('reads version bumps, honouring bump-minor-pre-major', () => {
    expect(levelFromVersions('0.2.0', '0.3.0', pre(true))).toBe('major');
    expect(levelFromVersions('0.2.0', '0.3.0', pre(false))).toBe('minor');
    expect(levelFromVersions('0.2.0', '0.2.1', pre(true))).toBe('patch');
    expect(levelFromVersions('0.2.0', '0.2.1', pre(true, true))).toBe('minor');
    expect(levelFromVersions('1.4.2', '2.0.0', pre(true))).toBe('major');
    expect(levelFromVersions('1.4.2', '1.4.3', pre(true))).toBe('patch');
  });

  const major: ImpactChange = {
    unit: 'u',
    kind: 'interface',
    level: 'major',
    certain: true,
    message: 'm',
    loc: { file: 'f', line: 1, column: 1, endLine: 1, endColumn: 1 },
  };
  const patch: ImpactChange = { ...major, level: 'patch' };
  const verdict = (cs: ImpactChange[], d: DeclaredInput, policy = DEFAULT_IMPACT_POLICY) =>
    impactVerdict(cs, d, policy);

  it('fails an under-declared change, not an over-declared one', () => {
    expect(verdict([major], { title: 'fix: x' }).ok).toBe(false);
    expect(verdict([major], { title: 'fix!: x' }).ok).toBe(true);
    expect(verdict([patch], { title: 'feat!: x' }).ok).toBe(true);
    // patch vs none: the change ships with the next release anyway
    expect(verdict([patch], { title: 'chore: x' }).ok).toBe(true);
  });

  it('uses one authoritative source and flags a higher advisory one', () => {
    const v = verdict([major], { title: 'fix: x', labels: ['semver:major'] });
    expect(v.declared?.kind).toBe('title');
    expect(v.conflict?.kind).toBe('labels');
    expect(v.ok).toBe(false);
    const byLabels = verdict(
      [major],
      { title: 'fix: x', labels: ['semver:major'] },
      { ...DEFAULT_IMPACT_POLICY, declaredBy: 'labels' },
    );
    expect(byLabels.declared?.kind).toBe('labels');
    expect(byLabels.ok).toBe(true);
    expect(verdict([major], { explicit: 'major', title: 'fix: x' }).declared?.kind).toBe('explicit');
  });

  it('treats a non-Conventional title as undeclared, and counts uncertain changes only on request', () => {
    expect(verdict([major], { title: 'Update ci.yml' }).declared).toBeUndefined();
    const uncertain = { ...major, certain: false };
    expect(verdict([uncertain], { title: 'fix: x' }).required).toBe('none');
    expect(
      verdict([uncertain], { title: 'fix: x' }, { ...DEFAULT_IMPACT_POLICY, uncertain: 'fail' }).ok,
    ).toBe(false);
  });
});

describe('impact rules', () => {
  const before = { [`${WF}/r.yml`]: reusable(job('test', '    name: Test\n')) };
  const after = { [`${WF}/r.yml`]: reusable(job('test', '    name: Unit tests\n')) };
  const run = (declared: DeclaredInput, files = after) =>
    analyze({
      root: '/v',
      fs: memoryFileSystem(files),
      validateSchema: false,
      repository: 'a/b',
      impact: {
        base: index(before),
        baseline: { kind: 'ref', ref: 'main', commit: 'abc' },
        declared,
        policy: DEFAULT_IMPACT_POLICY,
      },
    });

  it('reports FP810 for an under-declared change and FP813 when nothing is declared', () => {
    expect(codes(run({ title: 'fix: x' }))).toContain('FP810');
    expect(codes(run({}))).toContain('FP813');
    expect(codes(run({ title: 'fix!: x' })).filter((c) => /^FP81/.test(c))).toEqual([]);
    expect(codes(run({ title: 'fix: x', labels: ['semver:major'] }))).toEqual(
      expect.arrayContaining(['FP810', 'FP811']),
    );
    expect(codes(run({ title: 'fix!: x' }, before))).toContain('FP812');
  });

  it('has no impact findings without impact mode, and the result carries the verdict', () => {
    const r = analyze({ root: '/v', fs: memoryFileSystem(after), validateSchema: false, repository: 'a/b' });
    expect(codes(r).filter((c) => /^FP81/.test(c))).toEqual([]);
    expect(run({ title: 'fix: x' }).impact?.verdict).toMatchObject({ required: 'major', ok: false });
  });
});

describe('review fixes', () => {
  const wf = (body: string, inputs = '    inputs: {}\n') => `on:\n  workflow_call:\n${inputs}jobs:\n${body}`;

  it('resolves pass-through inputs and does not invent defaults for unknown values', () => {
    const inner = (def: string) =>
      wf(
        job('b', '    name: Build ${{ inputs.flavor }}\n'),
        `    inputs:\n      flavor: { type: string, default: ${def} }\n`,
      );
    const caller = (withValue: string, def = 'fast') =>
      wf(
        `  call:\n    uses: ./.github/workflows/inner.yml\n    with:\n      flavor: ${withValue}\n`,
        `    inputs:\n      flavor: { type: string, default: ${def} }\n`,
      );
    const publish = ['.github/workflows/reuse.yml'];
    // The caller always passes the event name: the inner default no longer matters.
    expect(
      changes(
        { [`${WF}/reuse.yml`]: caller('${{ github.event_name }}'), [`${WF}/inner.yml`]: inner('slow') },
        { [`${WF}/reuse.yml`]: caller('${{ github.event_name }}'), [`${WF}/inner.yml`]: inner('slower') },
        publish,
      ).filter((c) => c.certain),
    ).toEqual([]);
    // A pass-through of a consumer's input: the name depends on the consumer, not on the default.
    const cs = changes(
      { [`${WF}/reuse.yml`]: caller('${{ inputs.flavor }}', 'fast'), [`${WF}/inner.yml`]: inner('x') },
      { [`${WF}/reuse.yml`]: caller('${{ inputs.flavor }}', 'quick'), [`${WF}/inner.yml`]: inner('x') },
      publish,
    );
    expect(cs.filter((c) => c.kind === 'check-name' && c.certain)).toEqual([]);
  });

  it('a rename stays certain when the matrix is computed at runtime', () => {
    const t = (name: string) =>
      wf(
        job(
          't',
          `    name: ${name}\n    strategy:\n      matrix:\n        os: \${{ fromJSON(inputs.oses) }}\n`,
        ),
        `    inputs:\n      oses: { type: string, default: '["a"]' }\n`,
      );
    expect(summary(changes({ [`${WF}/r.yml`]: t('Test') }, { [`${WF}/r.yml`]: t('Tests') }))).toEqual([
      'major check "… / Test (…)" is now "… / Tests (…)"; consumers that require the old name wait forever',
    ]);
  });

  it('a job id rename that keeps the check name is not a change', () => {
    expect(
      changes(
        { [`${WF}/r.yml`]: wf(job('old', '    name: Test\n')) },
        { [`${WF}/r.yml`]: wf(job('new', '    name: Test\n')) },
      ),
    ).toEqual([]);
  });

  it('checks permissions per job, also when another job inherits, and in called workflows', () => {
    expect(
      summary(
        changes(
          { [`${WF}/r.yml`]: wf(job('test') + job('deploy')) },
          { [`${WF}/r.yml`]: wf(job('test') + job('deploy', '    permissions: { id-token: write }\n')) },
        ),
      ),
    ).toEqual([
      'major? jobs.deploy now requests id-token: write; callers that grant less fail when the run starts',
    ]);
    const reuse = `${wf('  call:\n    uses: ./.github/workflows/inner.yml\n')}`;
    const inner = (p: string) => `on: workflow_call\npermissions: ${p}\njobs:\n${job('j')}`;
    expect(
      summary(
        changes(
          { [`${WF}/reuse.yml`]: reuse, [`${WF}/inner.yml`]: inner('{ contents: read }') },
          { [`${WF}/reuse.yml`]: reuse, [`${WF}/inner.yml`]: inner('{ contents: read, id-token: write }') },
          ['.github/workflows/reuse.yml'],
        ),
      ),
    ).toEqual([
      'major jobs.call › j now requests id-token: write; callers that grant less fail when the run starts',
    ]);
  });

  it('does not grade workflow_dispatch inputs, and reports a published unit that stops parsing', () => {
    const both = (opts: string) =>
      `on:\n  workflow_call:\n  workflow_dispatch:\n    inputs:\n      env: { type: choice, options: [${opts}] }\njobs:\n${job('t')}`;
    expect(
      changes({ [`${WF}/r.yml`]: both('dev, prod, staging') }, { [`${WF}/r.yml`]: both('dev, prod') }),
    ).toEqual([]);
    const broken = changes(
      { [`${WF}/r.yml`]: wf(job('t')) },
      { [`${WF}/r.yml`]: 'on: [workflow_call\njobs: {' },
    );
    expect(broken.map((c) => [c.level, c.certain, c.kind])).toEqual([['major', true, 'unit']]);
  });

  it('treats _-prefixed reusable workflows as internal and keeps a unit that still exists', () => {
    expect(
      changes(
        { [`${WF}/_build.yml`]: wf(job('t', '    name: Compile\n')) },
        { [`${WF}/_build.yml`]: wf(job('t', '    name: Build\n')) },
      ),
    ).toEqual([]);
    const action = 'name: a\ndescription: d\nruns:\n  using: node24\n  main: index.js\n';
    const base = index({ 'actions/setup/action.yml': action }, ['actions/*']);
    const head = index({ 'actions/setup/action.yml': action });
    expect(
      impactChanges(base, head, { publish: ['actions/*'] }, (f) => f === 'actions/setup/action.yml'),
    ).toEqual([]);
  });

  it('lets **/ match no directory, so the root action is published by **/action.yml', () => {
    const action = (using: string) => `name: a\ndescription: d\nruns:\n  using: ${using}\n  main: index.js\n`;
    expect(
      summary(
        changes({ 'action.yml': action('node20') }, { 'action.yml': action('node24') }, ['**/action.yml']),
      ),
    ).toHaveLength(1);
  });

  it('reports an interface change at the declaration it names', () => {
    const action = (extra: string) =>
      `name: a\ndescription: d\ninputs:\n  a: { description: x }\n${extra}runs:\n  using: node24\n  main: index.js\n`;
    const [added] = changes(
      { 'action.yml': action('') },
      { 'action.yml': action('  b: { description: y }\n') },
    );
    expect(added?.loc).toMatchObject({ file: 'action.yml', line: 5 });
  });

  it('keeps labels advisory when the title is not a Conventional Commit', () => {
    const major = changes(
      { [`${WF}/r.yml`]: wf(job('t', '    name: A\n')) },
      { [`${WF}/r.yml`]: wf(job('t', '    name: B\n')) },
    );
    const v = impactVerdict(
      major,
      { title: 'Update ci.yml', labels: ['semver:major'] },
      DEFAULT_IMPACT_POLICY,
    );
    expect(v.declared).toBeUndefined();
    expect(v.ok).toBe(true);
  });
});

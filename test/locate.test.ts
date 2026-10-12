import { type Loc, SymbolLocator, sym } from '@ciatlas/core';
import { describe, expect, it } from 'vitest';
import { load, WF, yaml } from './helpers';

const ROOT = `${WF}/root.yml`;
const MID = `${WF}/mid.yml`;
const OTHER = `${WF}/other.yml`;
const BUILD = '.github/actions/build';
const BUILD_FILE = `${BUILD}/action.yml`;
const DEPLOY = 'acme/shared/.github/workflows/deploy.yml@v1';

const files: Record<string, string> = {
  [ROOT]: yaml`
    on:
      workflow_dispatch:
        inputs:
          config: { type: string, required: true }
    jobs:
      mid:
        uses: ./.github/workflows/mid.yml
        with:
          cfg: \${{ inputs.CONFIG }}
        secrets:
          TOKEN: \${{ secrets.DEPLOY_TOKEN }}
      after:
        needs: [mid]
        if: needs.mid.result == 'success'
        runs-on: ubuntu-latest
        strategy:
          matrix:
            os: [linux, mac]
            include:
              - os: windows
                arch: arm
        env:
          MODE: fast
        steps:
          - id: build
            uses: ./.github/actions/build
            with:
              target: \${{ matrix.os }}
          - id: sh
            run: echo "v=1" >> "$GITHUB_OUTPUT"
          - run: echo \${{ needs.mid.outputs.result }} \${{ steps.build.outputs.artifact }} \${{ steps.sh.outputs.v }}
          - run: echo \${{ env.MODE }} \${{ vars.REGION }} \${{ fromJSON(inputs.config)[matrix.arch] }}
      remote:
        uses: ${DEPLOY}
  `,
  [MID]: yaml`
    on:
      workflow_call:
        inputs:
          cfg: { type: string, required: true }
        secrets:
          TOKEN: { required: true }
        outputs:
          result:
            value: \${{ jobs.leaf.outputs.r }}
    jobs:
      leaf:
        runs-on: x
        outputs:
          r: \${{ steps.s.outputs.r }}
        steps:
          - id: s
            run: echo "r=\${{ inputs.cfg }}-\${{ secrets.TOKEN }}" >> $GITHUB_OUTPUT
          - uses: actions/checkout@v4
  `,
  [OTHER]: yaml`
    on: push
    jobs:
      deploy:
        uses: ${DEPLOY}
  `,
  [BUILD_FILE]: yaml`
    name: build
    inputs:
      target: { required: true }
    outputs:
      artifact:
        value: \${{ steps.pack.outputs.path }}
    runs:
      using: composite
      steps:
        - id: pack
          shell: bash
          run: echo "path=\${{ inputs.target }}" >> $GITHUB_OUTPUT
  `,
};

const locator = new SymbolLocator(load(files).index);

/** 1-based position of the `nth` occurrence of `needle` in `text`, moved right by `offset` characters. */
function positionIn(text: string, needle: string, offset = 0, nth = 0): { line: number; column: number } {
  let i = -1;
  for (let n = 0; n <= nth; n++) {
    i = text.indexOf(needle, i + 1);
    if (i < 0) throw new Error(`${needle} not found`);
  }
  const before = text.slice(0, i + offset).split('\n');
  return { line: before.length, column: before.at(-1)!.length + 1 };
}

/** 1-based position of the `nth` occurrence of `needle` in a file, moved right by `offset` characters. */
const pos = (file: string, needle: string, offset = 0, nth = 0) =>
  positionIn(files[file]!, needle, offset, nth);

const at = (file: string, needle: string, offset = 0, nth = 0) => {
  const p = pos(file, needle, offset, nth);
  return locator.at(file, p.line, p.column);
};
const start = (file: string, needle: string, nth = 0) => ({ file, ...pos(file, needle, 0, nth) });
const declared = (symbol: string) =>
  locator.declarations(symbol).map((d) => ({ kind: d.kind, unit: d.unit, ...d.loc }));
const where = (l: Loc) => `${l.file}:${l.line}:${l.column}`;

describe('SymbolLocator.at', () => {
  it('finds the symbol an expression reads, case-insensitively', () => {
    expect(at(ROOT, 'inputs.CONFIG', 3)).toMatchObject({ symbol: sym.input(ROOT, 'config'), role: 'read' });
    expect(declared(sym.input(ROOT, 'config'))).toMatchObject([{ kind: 'input', ...start(ROOT, 'config:') }]);
  });

  it('finds the callee input or secret a `with:` or `secrets:` key sets', () => {
    expect(at(ROOT, 'cfg:')).toMatchObject({ symbol: sym.input(MID, 'cfg'), role: 'binding' });
    expect(declared(sym.input(MID, 'cfg'))).toMatchObject([
      { kind: 'input', unit: MID, ...start(MID, 'cfg:') },
    ]);
    expect(at(ROOT, 'TOKEN:')).toMatchObject({ symbol: sym.secret(MID, 'TOKEN'), role: 'binding' });
    expect(declared(sym.secret(MID, 'TOKEN'))).toMatchObject([{ kind: 'secret', ...start(MID, 'TOKEN:') }]);
    expect(at(ROOT, 'target:')).toMatchObject({ symbol: sym.input(BUILD, 'target'), role: 'binding' });
    expect(declared(sym.input(BUILD, 'target'))).toMatchObject([
      { unit: BUILD, ...start(BUILD_FILE, 'target:') },
    ]);
  });

  it('declares a calling job’s outputs at the callee’s workflow outputs', () => {
    const symbol = sym.jobOutput(ROOT, 'mid', 'result');
    expect(at(ROOT, 'needs.mid.outputs.result', 20)).toMatchObject({ symbol, role: 'read' });
    expect(declared(symbol)).toMatchObject([{ kind: 'output', unit: MID, ...start(MID, 'result:') }]);
  });

  it('declares step outputs at the action output, or at the step when nothing declares them', () => {
    const fromAction = sym.stepOutput(ROOT, 'after', 'build', 'artifact');
    expect(at(ROOT, 'steps.build.outputs.artifact')).toMatchObject({ symbol: fromAction });
    expect(declared(fromAction)).toMatchObject([
      { kind: 'output', unit: BUILD, ...start(BUILD_FILE, 'artifact:') },
    ]);
    const fromScript = sym.stepOutput(ROOT, 'after', 'sh', 'v');
    expect(at(ROOT, 'steps.sh.outputs.v')).toMatchObject({ symbol: fromScript });
    expect(declared(fromScript)).toMatchObject([{ kind: 'step', ...start(ROOT, 'id: sh') }]);
    const inAction = sym.stepOutput(BUILD, undefined, 'pack', 'path');
    expect(at(BUILD_FILE, 'steps.pack.outputs.path')).toMatchObject({ symbol: inAction });
    expect(declared(inAction)).toMatchObject([{ kind: 'step', ...start(BUILD_FILE, 'id: pack') }]);
  });

  it('finds jobs from `needs:` entries and from reads that name no output', () => {
    const job = sym.job(ROOT, 'mid');
    expect(at(ROOT, '[mid]', 1)).toMatchObject({ symbol: job, role: 'needs' });
    expect(at(ROOT, 'needs.mid.result')).toMatchObject({ symbol: job, role: 'read' });
    expect(declared(job)).toMatchObject([{ kind: 'job', ...start(ROOT, 'mid:') }]);
    expect(at(MID, 'jobs.leaf.outputs.r')).toMatchObject({ symbol: sym.jobOutput(MID, 'leaf', 'r') });
  });

  it('declares matrix keys at every dimension and include entry that sets them', () => {
    const os = sym.matrix(ROOT, 'after', 'os');
    expect(at(ROOT, 'matrix.os')).toMatchObject({ symbol: os, role: 'read' });
    expect(declared(os)).toMatchObject([start(ROOT, 'os:'), start(ROOT, 'os:', 1)]);
  });

  it('finds env and variables', () => {
    const mode = sym.env(ROOT, 'after', 'MODE');
    expect(at(ROOT, 'env.MODE')).toMatchObject({ symbol: mode });
    expect(declared(mode)).toMatchObject([{ kind: 'env', ...start(ROOT, 'MODE:') }]);
    expect(at(ROOT, 'vars.REGION')).toMatchObject({ symbol: sym.var('REGION') });
    expect(declared(sym.var('REGION'))).toEqual([]);
  });

  it('prefers the innermost reference', () => {
    expect(at(ROOT, 'matrix.arch', 2)).toMatchObject({ symbol: sym.matrix(ROOT, 'after', 'arch') });
    expect(at(ROOT, 'fromJSON(inputs.config)', 10)).toMatchObject({ symbol: sym.input(ROOT, 'config') });
  });

  it('finds the workflow or action a `uses:` names, and remote references', () => {
    expect(at(ROOT, './.github/workflows/mid.yml', 5)).toMatchObject({ symbol: MID, role: 'uses' });
    expect(declared(MID)).toMatchObject([{ kind: 'unit', file: MID, line: 1, column: 1 }]);
    expect(at(ROOT, './.github/actions/build')).toMatchObject({ symbol: BUILD, role: 'uses' });
    expect(declared(BUILD)).toMatchObject([{ kind: 'unit', file: BUILD_FILE, line: 1, column: 1 }]);
    expect(at(ROOT, 'acme/shared')).toMatchObject({ symbol: sym.remote(DEPLOY), role: 'uses' });
    expect(at(MID, 'actions/checkout@v4')).toMatchObject({ symbol: sym.remote('actions/checkout@v4') });
    expect(declared(sym.remote(DEPLOY))).toEqual([]);
  });

  it('matches a cursor right after a name, and nothing elsewhere', () => {
    expect(at(ROOT, 'inputs.CONFIG', 'inputs.CONFIG'.length)?.symbol).toBe(sym.input(ROOT, 'config'));
    expect(at(ROOT, 'runs-on')).toBeUndefined();
    expect(at(ROOT, '${{ inputs.CONFIG', 1)).toBeUndefined();
    expect(locator.at('.github/workflows/missing.yml', 1, 1)).toBeUndefined();
  });
});

describe('SymbolLocator.occurrences', () => {
  it('lists declarations, bindings and reads across files in order', () => {
    const list = locator.occurrences(sym.input(MID, 'cfg'));
    expect(list.map((o) => `${o.role} ${where(o.loc)}`)).toEqual([
      `declaration ${where(start(MID, 'cfg:') as Loc)}`,
      `read ${where(start(MID, 'inputs.cfg') as Loc)}`,
      `binding ${where(start(ROOT, 'cfg:') as Loc)}`,
    ]);
  });

  it('lists every `uses:` of a unit and of a remote reference', () => {
    expect(locator.occurrences(MID).map((o) => o.role)).toEqual(['uses']);
    expect(locator.occurrences(sym.remote(DEPLOY)).map((o) => o.loc.file)).toEqual([OTHER, ROOT]);
  });

  it('lists `needs:` entries with the job’s declaration and reads', () => {
    expect(locator.occurrences(sym.job(ROOT, 'mid')).map((o) => o.role)).toEqual([
      'declaration',
      'needs',
      'read',
    ]);
  });
});

describe('SymbolLocator with $/ and workspace paths', () => {
  const W = `${WF}/self.yml`;
  const text = yaml`
    on: push
    jobs:
      call:
        uses: $/.github/workflows/mid.yml
        with:
          cfg: x
      steps:
        runs-on: x
        steps:
          - uses: actions/checkout@v4
            with:
              path: src/app
          - uses: $/.github/actions/build
            with:
              target: a
          - uses: ./src/app/.github/actions/build
            with:
              target: b
  `;
  const own = new SymbolLocator(load({ ...files, [W]: text }).index);
  const find = (needle: string, offset = 0) => {
    const before = text.slice(0, text.indexOf(needle) + offset).split('\n');
    return own.at(W, before.length, before.at(-1)!.length + 1);
  };

  it('resolves $/ and checkout-relative uses: to the unit, with their bindings', () => {
    expect(find('$/.github/workflows/mid.yml', 3)).toMatchObject({ symbol: MID, role: 'uses' });
    expect(find('$/.github/actions/build', 3)).toMatchObject({ symbol: BUILD, role: 'uses' });
    expect(find('./src/app/.github/actions/build', 3)).toMatchObject({ symbol: BUILD, role: 'uses' });
    expect(find('cfg: x')).toMatchObject({ symbol: sym.input(MID, 'cfg'), role: 'binding' });
    expect(find('target: b')).toMatchObject({ symbol: sym.input(BUILD, 'target'), role: 'binding' });
    expect(own.occurrences(BUILD).filter((o) => o.loc.file === W)).toHaveLength(2);
  });
});

describe('SymbolLocator: whole outputs objects', () => {
  const W = `${WF}/whole.yml`;
  const text = yaml`
    on: push
    jobs:
      build:
        runs-on: x
        outputs:
          digest: x
          tag: y
        steps:
          - id: meta
            uses: ./.github/actions/build
          - run: echo '\${{ toJSON(steps.meta.outputs) }}'
      use:
        needs: build
        runs-on: x
        steps:
          - run: echo '\${{ toJSON(needs.build.outputs) }}'
  `;
  const whole = new SymbolLocator(load({ [W]: text, [BUILD_FILE]: files[BUILD_FILE]! }).index);
  const line = (needle: string) => text.slice(0, text.indexOf(needle)).split('\n').length;

  it('lists a read of the whole object among the references of each output, as FP303 counts it', () => {
    for (const name of ['digest', 'tag']) {
      expect(
        whole.occurrences(sym.jobOutput(W, 'build', name)).map((o) => `${o.role} ${o.loc.line}`),
      ).toEqual([`declaration ${line(`${name}:`)}`, `read ${line('needs.build.outputs')}`]);
    }
    expect(
      whole.occurrences(sym.stepOutput(W, 'build', 'meta', 'artifact')).map((o) => `${o.role} ${o.loc.line}`),
    ).toEqual([`read ${line('steps.meta.outputs')}`]);
  });

  it('keeps the position itself for the job, or for nothing', () => {
    const p = (needle: string) => {
      const before = text.slice(0, text.indexOf(needle) + 2).split('\n');
      return whole.at(W, before.length, before.at(-1)!.length + 1);
    };
    expect(p('needs.build.outputs')).toMatchObject({ symbol: sym.job(W, 'build'), role: 'read' });
    expect(p('steps.meta.outputs')).toBeUndefined();
  });
});

describe('SymbolLocator: env, aliases, script outputs and bindings', () => {
  const E = `${WF}/env.yml`;
  const LIB = `${WF}/lib.yml`;
  const PLAIN = `${WF}/plain.yml`;
  const more: Record<string, string> = {
    [E]: yaml`
      on:
        workflow_dispatch:
          inputs:
            level: { type: string }
      env:
        REGION: eu
        MODE: global
      jobs:
        a:
          runs-on: x
          env: &shared
            MODE: \${{ inputs.level }}
          steps:
            - id: sh
              run: echo "v=1" >> "$GITHUB_OUTPUT"
            - run: echo \${{ env.REGION }} \${{ env.MODE }} \${{ steps.sh.outputs.v }} \${{ steps.SH.outputs.v }}
            - uses: docker://alpine:3
        b:
          runs-on: x
          env: *shared
          steps:
            - run: echo \${{ env.MODE }}
        c:
          runs-on: x
          steps:
            - run: echo \${{ env.MODE }}
        call:
          uses: ./.github/workflows/lib.yml
          with:
            NAME: x
            nope: y
        plain:
          uses: ./.github/workflows/plain.yml
          with:
            name: x
    `,
    [LIB]: yaml`
      on:
        workflow_call:
          inputs:
            name: { type: string }
      jobs:
        j:
          runs-on: x
          steps:
            - run: echo \${{ inputs.name }}
    `,
    [PLAIN]: yaml`
      on:
        workflow_dispatch:
          inputs:
            name: { type: string }
      jobs:
        j:
          runs-on: x
          steps:
            - run: echo \${{ inputs.name }}
    `,
  };
  const loc = new SymbolLocator(load(more).index);
  const ePos = (needle: string, offset = 0, nth = 0) => positionIn(more[E]!, needle, offset, nth);
  const eAt = (needle: string, offset = 0, nth = 0) => {
    const p = ePos(needle, offset, nth);
    return loc.at(E, p.line, p.column);
  };
  const eStart = (needle: string, nth = 0) => ({ file: E, ...ePos(needle, 0, nth) });
  const roles = (symbol: string) => loc.occurrences(symbol).map((o) => `${o.role} ${where(o.loc)}`);

  it('declares workflow env, and lets a job’s env shadow it', () => {
    const region = sym.env(E, undefined, 'REGION');
    expect(eAt('env.REGION')).toMatchObject({ symbol: region, role: 'read' });
    expect(loc.declarations(region)).toMatchObject([{ kind: 'env', unit: E, loc: eStart('REGION:') }]);
    expect(eAt('env.MODE')).toMatchObject({ symbol: sym.env(E, 'a', 'MODE') });
    expect(eAt('env.MODE', 0, 2)).toMatchObject({ symbol: sym.env(E, undefined, 'MODE') });
    expect(roles(sym.env(E, undefined, 'MODE'))).toEqual([
      `declaration ${where(eStart('MODE: global') as Loc)}`,
      `read ${where(eStart('env.MODE', 2) as Loc)}`,
    ]);
  });

  it('lists a name a YAML alias repeats once, and declares each job’s copy at the anchor', () => {
    expect(roles(sym.input(E, 'level'))).toEqual([
      `declaration ${where(eStart('level:') as Loc)}`,
      `read ${where(eStart('inputs.level') as Loc)}`,
    ]);
    const anchor = eStart('MODE: ${{');
    expect(loc.declarations(sym.env(E, 'a', 'MODE'))).toMatchObject([{ kind: 'env', loc: anchor }]);
    expect(loc.declarations(sym.env(E, 'b', 'MODE'))).toMatchObject([{ kind: 'env', loc: anchor }]);
    expect(eAt('env.MODE', 0, 1)).toMatchObject({ symbol: sym.env(E, 'b', 'MODE') });
  });

  it('declares a script step’s outputs once at the step, however often they are read', () => {
    const v = sym.stepOutput(E, 'a', 'sh', 'v');
    expect(eAt('steps.SH.outputs.v')).toMatchObject({ symbol: v, role: 'read' });
    expect(loc.declarations(v)).toMatchObject([{ kind: 'step', loc: eStart('id: sh'), decl: { id: 'sh' } }]);
    // The step is the closest definition, not a place the output's name is written.
    expect(roles(v)).toEqual([
      `read ${where(eStart('steps.sh.outputs.v') as Loc)}`,
      `read ${where(eStart('steps.SH.outputs.v') as Loc)}`,
    ]);
  });

  it('binds only the inputs a reusable workflow declares, by their declared case', () => {
    expect(eAt('NAME:')).toMatchObject({ symbol: sym.input(LIB, 'name'), role: 'binding' });
    expect(eAt('nope:')).toBeUndefined();
    // plain.yml is not reusable: the job names it, but its `with:` keys set nothing.
    expect(eAt('./.github/workflows/plain.yml')).toMatchObject({ symbol: PLAIN, role: 'uses' });
    expect(eAt('name: x')).toBeUndefined();
    expect(loc.occurrences(sym.input(PLAIN, 'name')).map((o) => o.role)).toEqual(['declaration', 'read']);
  });

  it('does not treat a docker image as a remote unit', () => {
    expect(eAt('docker://alpine:3')).toBeUndefined();
    expect(loc.occurrences(sym.remote('docker://alpine:3'))).toEqual([]);
  });

  it('declares action outputs at their key; a step’s outputs point there without being written there', () => {
    expect(declared(sym.output(BUILD, 'artifact'))).toMatchObject([
      { kind: 'output', unit: BUILD, ...start(BUILD_FILE, 'artifact:') },
    ]);
    expect(locator.occurrences(sym.output(BUILD, 'artifact')).map((o) => o.role)).toEqual(['declaration']);
    expect(
      locator.occurrences(sym.stepOutput(ROOT, 'after', 'build', 'artifact')).map((o) => o.role),
    ).toEqual(['read']);
    expect(locator.occurrences(sym.jobOutput(ROOT, 'mid', 'result')).map((o) => o.role)).toEqual(['read']);
  });
});

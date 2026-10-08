import { describe, expect, it } from 'vitest';
import { at, byCode, lint, WF, yaml } from '../helpers';

const pipeline = (consumer: string) => yaml`
  on: push
  jobs:
    build:
      runs-on: x
      outputs:
        version: \${{ steps.meta.outputs.version }}
        unused: x
      steps:
        - id: meta
          run: echo "version=1" >> $GITHUB_OUTPUT
    call:
      uses: ./.github/workflows/lib.yml
    consume:
      needs: [build, call]
      runs-on: x
      steps:
        - run: ${consumer}
`;

const lib = yaml`
  on:
    workflow_call:
      outputs:
        url:
          value: \${{ jobs.j.outputs.url }}
        dead:
          value: \${{ jobs.j.outputs.url }}
  jobs:
    j:
      runs-on: x
      outputs:
        url: \${{ steps.s.outputs.url }}
      steps:
        - id: s
          run: echo "url=x" >> $GITHUB_OUTPUT
`;

describe('FP301 undefined-output-ref', () => {
  it('flags unknown job outputs and reusable workflow outputs', () => {
    const r = lint({
      [`${WF}/p.yml`]: pipeline(
        'echo ${{ needs.build.outputs.versoin }} ${{ needs.call.outputs.uri }} ${{ needs.call.outputs.url }}',
      ),
      [`${WF}/lib.yml`]: lib,
    });
    expect(byCode(r, 'FP301').map((f) => f.message)).toEqual([
      'jobs.build has no output "versoin" — did you mean "version"?',
      'jobs.call has no output "uri" — did you mean "url"?',
    ]);
  });

  it('flags workflow outputs that point at missing jobs or outputs', () => {
    const broken = lint({
      [`${WF}/lib.yml`]: lib
        .replace(
          'url:\n        value: ${{ jobs.j.outputs.url }}',
          'url:\n        value: ${{ jobs.k.outputs.url }}',
        )
        .replace(
          'dead:\n        value: ${{ jobs.j.outputs.url }}',
          'dead:\n        value: ${{ jobs.j.outputs.nope }}',
        ),
    });
    const r = broken;
    expect(byCode(r, 'FP301').map((f) => f.message)).toEqual([
      '.github/workflows/lib.yml has no job "k"',
      'jobs.j has no output "nope"',
    ]);
  });

  it('flags missing step ids and steps that run later', () => {
    const r = lint({
      [`${WF}/w.yml`]: yaml`
        on: push
        jobs:
          j:
            runs-on: x
            outputs:
              a: \${{ steps.nope.outputs.a }}
            steps:
              - run: echo \${{ steps.later.outputs.x }}
              - id: later
                run: echo "x=1" >> $GITHUB_OUTPUT
              - run: echo \${{ steps.later.outputs.x }}
      `,
    });
    expect(byCode(r, 'FP301').map((f) => f.message)).toEqual([
      'No step with id "nope" in jobs.j',
      'Step "later" runs after this step, so its outputs are not available yet',
    ]);
  });

  it('checks outputs of local actions', () => {
    const r = lint({
      [`${WF}/w.yml`]:
        'on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - id: a\n        uses: ./.github/actions/a\n      - run: echo ${{ steps.a.outputs.missing }}\n',
      '.github/actions/a/action.yml':
        'outputs:\n  present:\n    value: x\nruns:\n  using: composite\n  steps: []\n',
    });
    expect(byCode(r, 'FP301')[0]?.message).toBe('.github/actions/a has no output "missing"');
  });

  it('does not judge remote reusable workflows', () => {
    const r = lint({
      [`${WF}/w.yml`]:
        'on: push\njobs:\n  r:\n    uses: o/r/.github/workflows/x.yml@v1\n  c:\n    needs: r\n    runs-on: x\n    steps:\n      - run: echo ${{ needs.r.outputs.any }}\n',
    });
    expect(byCode(r, 'FP301')).toEqual([]);
  });
});

describe('FP302 output-ref-without-needs', () => {
  it('flags needs.<job> reads without a needs edge, and unknown jobs', () => {
    const r = lint({
      [`${WF}/w.yml`]: yaml`
        on: push
        jobs:
          a:
            runs-on: x
            outputs: { v: x }
            steps: [{ run: x }]
          b:
            runs-on: x
            steps:
              - run: echo \${{ needs.a.outputs.v }} \${{ needs.ghost.result }}
      `,
    });
    const fs = byCode(r, 'FP302');
    expect(fs.map((f) => f.message)).toEqual([
      'jobs.b reads needs.a but does not list "a" under needs',
      'jobs.b reads needs.ghost, but .github/workflows/w.yml has no job "ghost"',
    ]);
    expect(fs[0]!.fix).toBe('Add "a" to jobs.b.needs.');
  });
});

describe('FP303 unused-output', () => {
  it('flags unread job outputs and workflow outputs no caller reads', () => {
    const r = lint({
      [`${WF}/p.yml`]: pipeline('echo ${{ needs.build.outputs.version }} ${{ needs.call.outputs.url }}'),
      [`${WF}/lib.yml`]: lib,
    });
    expect(byCode(r, 'FP303').map((f) => f.message)).toEqual([
      'Workflow output "dead" of .github/workflows/lib.yml is not read by any of its 1 caller',
      'Output "unused" of jobs.build is never read',
    ]);
  });

  it('does not judge workflow outputs without local callers', () => {
    const r = lint({ [`${WF}/lib.yml`]: lib });
    expect(byCode(r, 'FP303')).toEqual([]);
  });

  it('flags action outputs that no user reads', () => {
    const r = lint({
      [`${WF}/w.yml`]:
        'on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - id: a\n        uses: ./.github/actions/a\n      - run: echo ${{ steps.a.outputs.used }}\n',
      '.github/actions/a/action.yml':
        'outputs:\n  used:\n    value: x\n  dead:\n    value: y\nruns:\n  using: composite\n  steps: []\n',
    });
    expect(byCode(r, 'FP303').map((f) => f.symbol)).toEqual(['.github/actions/a#outputs.dead']);
  });
});

describe('FP304 step-output-never-written', () => {
  it('flags outputs the inline script never writes', () => {
    const r = lint({
      [`${WF}/w.yml`]: pipeline('x').replace('steps.meta.outputs.version', 'steps.meta.outputs.ver'),
    });
    const [f] = byCode(r, 'FP304');
    expect(f?.message).toBe(
      'Step "meta" never writes output "ver" (it writes version) — did you mean "version"?',
    );
    expect(at(f!)).toBe(`${WF}/w.yml:6:20`);
  });

  it('stays quiet for dynamic writes and scripts that do not mention GITHUB_OUTPUT', () => {
    const r = lint({
      [`${WF}/w.yml`]: yaml`
        on: push
        jobs:
          j:
            runs-on: x
            outputs:
              a: \${{ steps.dyn.outputs.a }}
              b: \${{ steps.ext.outputs.b }}
            steps:
              - id: dyn
                run: cat out.env >> "$GITHUB_OUTPUT"
              - id: ext
                run: ./script.sh
      `,
    });
    expect(byCode(r, 'FP304')).toEqual([]);
  });
});

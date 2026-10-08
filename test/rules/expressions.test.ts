import { describe, expect, it } from 'vitest';
import { at, byCode, codes, lint, WF, yaml } from '../helpers';

describe('WFC501 undefined-env-ref', () => {
  it('resolves env through step, job and workflow scope and earlier $GITHUB_ENV writes', () => {
    const r = lint({
      [`${WF}/w.yml`]: yaml`
        on: push
        env:
          W: 1
        jobs:
          j:
            runs-on: x
            env:
              J: 2
            steps:
              - run: echo "E=3" >> $GITHUB_ENV
              - env:
                  S: 4
                run: echo \${{ env.W }} \${{ env.J }} \${{ env.S }} \${{ env.E }} \${{ env.NOPE }}
      `,
    });
    expect(byCode(r, 'WFC501').map((f) => f.message)).toEqual(['env.NOPE is not defined in this scope']);
  });

  it('points runner variables to the matching context', () => {
    const r = lint({
      [`${WF}/w.yml`]:
        'on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: echo ${{ env.GITHUB_SHA }}\n',
    });
    const [f] = byCode(r, 'WFC501');
    expect(f?.message).toContain('use github.sha');
    expect(f?.fix).toBe('Replace `env.GITHUB_SHA` with `github.sha`.');
  });

  it('gives up after steps that may export variables invisibly', () => {
    const r = lint({
      [`${WF}/w.yml`]:
        'on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - uses: some/action@v1\n      - run: echo ${{ env.FROM_ACTION }}\n',
    });
    expect(byCode(r, 'WFC501')).toEqual([]);
  });
});

describe('WFC502 expression-parse-error', () => {
  it('reports syntax errors at the offending token', () => {
    const r = lint({
      [`${WF}/w.yml`]:
        "on: push\njobs:\n  j:\n    if: ${{ github.ref = 'main' }}\n    runs-on: x\n    steps: [{ run: x }]\n",
    });
    const [f] = byCode(r, 'WFC502');
    expect(f?.message).toBe("Invalid expression \"github.ref = 'main'\": Unexpected symbol: '='");
    expect(at(f!)).toBe(`${WF}/w.yml:4:24`);
  });
});

describe('WFC503 schema-violation / WFC504 yaml-syntax-error', () => {
  it('validates against GitHub’s schema when enabled', () => {
    const r = lint(
      { [`${WF}/w.yml`]: 'on: push\njobs:\n  j:\n    runs-on: x\n    stepz: []\n' },
      { schema: true },
    );
    expect(byCode(r, 'WFC503')[0]?.message).toBe("Unexpected value 'stepz'");
    expect(at(byCode(r, 'WFC503')[0]!)).toBe(`${WF}/w.yml:5:5`);
  });

  it('validates action files', () => {
    const r = lint({ '.github/actions/a/action.yml': 'name: a\nrunz: {}\n' }, { schema: true });
    expect(codes(r)).toContain('WFC503');
  });

  it('reports YAML errors once (no schema duplicate)', () => {
    const r = lint({ [`${WF}/w.yml`]: 'on: push\njobs: [a\n' }, { schema: true });
    expect(codes(r)).toContain('WFC504');
    expect(codes(r)).not.toContain('WFC503');
  });
});

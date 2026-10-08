import { describe, expect, it } from 'vitest';
import { byCode, lint, WF, yaml } from '../helpers';

const callee = yaml`
  on:
    workflow_call:
      secrets:
        token: { required: true }
        optional: { required: false }
        unused: {}
  jobs:
    j:
      runs-on: x
      steps:
        - run: deploy \${{ secrets.token }} \${{ secrets.optional }} \${{ secrets.GITHUB_TOKEN }}
`;
const caller = (secrets: string) =>
  `on: push\njobs:\n  call:\n    uses: ./.github/workflows/callee.yml\n${secrets}`;

describe('FP201 missing-required-secret', () => {
  it('flags a missing required secret', () => {
    const r = lint({
      [`${WF}/caller.yml`]: caller('    secrets:\n      optional: x\n'),
      [`${WF}/callee.yml`]: callee,
    });
    expect(byCode(r, 'FP201').map((f) => f.message)).toEqual([
      'jobs.call calls .github/workflows/callee.yml without required secret "token"',
    ]);
  });
  it('accepts secrets: inherit', () => {
    const r = lint({ [`${WF}/caller.yml`]: caller('    secrets: inherit\n'), [`${WF}/callee.yml`]: callee });
    expect(byCode(r, 'FP201')).toEqual([]);
  });
});

describe('FP202 unknown-secret', () => {
  it('flags undeclared secrets with a suggestion', () => {
    const r = lint({
      [`${WF}/caller.yml`]: caller('    secrets:\n      token: x\n      tokn: y\n'),
      [`${WF}/callee.yml`]: callee,
    });
    expect(byCode(r, 'FP202')[0]?.message).toBe(
      '.github/workflows/callee.yml has no secret "tokn" — did you mean "token"?',
    );
  });
});

describe('FP203 unused-secret', () => {
  it('flags declared secrets that are never read', () => {
    const r = lint({ [`${WF}/callee.yml`]: callee });
    expect(byCode(r, 'FP203').map((f) => f.symbol)).toEqual([`${WF}/callee.yml#secrets.unused`]);
  });
  it('counts secrets forwarded to a callee through inherit', () => {
    const r = lint({
      [`${WF}/mid.yml`]: yaml`
        on:
          workflow_call:
            secrets:
              token: {}
        jobs:
          j:
            uses: ./.github/workflows/leaf.yml
            secrets: inherit
      `,
      [`${WF}/leaf.yml`]:
        'on: workflow_call\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: echo ${{ secrets.token }}\n',
    });
    expect(byCode(r, 'FP203')).toEqual([]);
  });
});

describe('FP204 secrets-inherit', () => {
  it('lists the secrets the callee tree actually reads and suggests an explicit mapping', () => {
    const r = lint({
      [`${WF}/caller.yml`]: caller('    secrets: inherit\n'),
      [`${WF}/callee.yml`]: callee.replace(
        'jobs:',
        'jobs:\n  nested:\n    uses: ./.github/workflows/leaf.yml\n    secrets: inherit',
      ),
      [`${WF}/leaf.yml`]:
        'on: workflow_call\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: echo ${{ secrets.NPM_TOKEN }}\n',
    });
    const f = byCode(r, 'FP204').find((x) => x.loc.file.endsWith('caller.yml'));
    expect(f?.message).toBe(
      'jobs.call inherits all secrets; .github/workflows/callee.yml and its callees read NPM_TOKEN, optional, token',
    );
    expect(f?.fix).toContain('NPM_TOKEN: ${{ secrets.NPM_TOKEN }}');
    expect(f?.severity).toBe('info');
  });
});

describe('FP205 undeclared-secret-ref', () => {
  it('flags reads of undeclared secrets when a caller does not inherit', () => {
    const r = lint({
      [`${WF}/caller.yml`]: caller('    secrets:\n      token: x\n'),
      [`${WF}/callee.yml`]: callee.replace(
        '${{ secrets.GITHUB_TOKEN }}',
        '${{ secrets.GITHUB_TOKEN }} ${{ secrets.EXTRA }}',
      ),
    });
    expect(byCode(r, 'FP205').map((f) => f.message)).toEqual([
      '.github/workflows/callee.yml reads secrets.EXTRA, which is not declared — it is empty when called from 1 caller without `secrets: inherit`',
    ]);
  });
  it('is quiet when every caller inherits', () => {
    const r = lint({
      [`${WF}/caller.yml`]: caller('    secrets: inherit\n'),
      [`${WF}/callee.yml`]: callee.replace('${{ secrets.GITHUB_TOKEN }}', '${{ secrets.EXTRA }}'),
    });
    expect(byCode(r, 'FP205')).toEqual([]);
  });
});

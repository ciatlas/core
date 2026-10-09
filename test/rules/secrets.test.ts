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

  describe('callers for which the read never runs (mastodon build-container-image.yml)', () => {
    const files = (callers: string, guard = "contains(inputs.push_to_images, 'tootsuite')", jobIf = '') => ({
      [`${WF}/callers.yml`]: `on: push\njobs:\n${callers}`,
      [`${WF}/build.yml`]: yaml`
        on:
          workflow_call:
            inputs:
              push_to_images: { type: string }
              push: { type: boolean }
              registry: { type: string, default: docker.io }
        jobs:
          build:
            runs-on: x${jobIf}
            steps:
              - name: Log in to Docker Hub
                if: ${guard}
                uses: docker/login-action@v3
                with:
                  username: \${{ secrets.DOCKERHUB_USERNAME }}
      `,
    });
    const call = (id: string, w = '', s = '') =>
      `  ${id}:\n    uses: ./.github/workflows/build.yml\n${w ? `    with:\n${w}` : ''}${s}`;
    const fp205 = (f: Record<string, string>) => byCode(lint(f), 'FP205').map((x) => x.message);

    it('skips callers that omit the input the step requires', () => {
      expect(
        fp205(
          files(
            call('test', '      push_to_images: ""\n') +
              call('test2') +
              call('push', '      push_to_images: tootsuite/mastodon\n', '    secrets: inherit\n'),
          ),
        ),
      ).toEqual([]);
    });

    it('still counts callers whose values make it run, or that pass values only known at runtime', () => {
      expect(
        fp205(
          files(
            call('test') +
              call('nightly', '      push_to_images: tootsuite/mastodon\n') +
              call('dyn', '      push_to_images: ${{ github.event.inputs.images }}\n'),
          ),
        ),
      ).toEqual([
        '.github/workflows/build.yml reads secrets.DOCKERHUB_USERNAME, which is not declared — it is empty when called from 2 callers without `secrets: inherit`',
      ]);
    });

    it('applies defaults and type defaults, and job conditions', () => {
      // `push` is a boolean: omitted means false.
      expect(fp205(files(call('a'), 'inputs.push'))).toEqual([]);
      // `registry` defaults to docker.io.
      expect(fp205(files(call('a'), "inputs.registry == 'docker.io'"))).toHaveLength(1);
      expect(fp205(files(call('a', '      registry: ghcr.io\n'), "inputs.registry == 'docker.io'"))).toEqual(
        [],
      );
      expect(fp205(files(call('a'), 'always()', '\n            if: inputs.push'))).toEqual([]);
      expect(fp205(files(call('a'), 'always()', '\n            if: inputs.registry'))).toHaveLength(1);
    });
  });
});

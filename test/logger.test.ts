import { createLogger, memorySink, resolveLogLevel, silentLogger } from '@wfc/core';
import { describe, expect, it } from 'vitest';

describe('logger', () => {
  it('filters by level and scopes children', () => {
    const sink = memorySink();
    const log = createLogger({ level: 'info', sink });
    log.debug('hidden');
    log.info('shown', { n: 1 });
    log.child('x').warn('child');
    expect(sink.records.map((r) => [r.level, r.scope, r.message])).toEqual([
      ['info', 'wfc', 'shown'],
      ['warn', 'wfc:x', 'child'],
    ]);
    expect(log.enabled('debug')).toBe(false);
  });

  it('times work and groups output', () => {
    const groups: string[] = [];
    const sink = {
      ...memorySink(),
      group: (t: string) => groups.push(`+${t}`),
      groupEnd: () => groups.push('-'),
    };
    const records: unknown[] = [];
    sink.write = (r) => void records.push(r);
    const log = createLogger({ level: 'trace', sink });
    expect(log.time('work', () => 42)).toBe(42);
    expect(log.group('G', () => 'v')).toBe('v');
    expect(records).toHaveLength(2);
    expect(groups).toEqual(['+G', '-']);
    expect(() =>
      log.time('boom', () => {
        throw new Error('x');
      }),
    ).toThrow('x');
  });

  it('silent logger does nothing', () => {
    expect(() => silentLogger.error('x')).not.toThrow();
  });

  it.each([
    [{}, {}, 'info'],
    [{ debug: true }, {}, 'debug'],
    [{ verbose: 1 }, {}, 'debug'],
    [{ verbose: 2 }, {}, 'trace'],
    [{ quiet: true, debug: true }, {}, 'error'],
    [{}, { WFC_DEBUG: '1' }, 'debug'],
    [{}, { WFC_DEBUG: 'trace' }, 'trace'],
    [{}, { RUNNER_DEBUG: '1' }, 'debug'],
    [{}, { ACTIONS_STEP_DEBUG: 'true' }, 'debug'],
    [{}, { WFC_DEBUG: '0' }, 'info'],
  ])('resolveLogLevel(%j, %j) = %s', (opts, env, level) => {
    expect(resolveLogLevel(opts, env)).toBe(level);
  });
});

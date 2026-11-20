import { describe, expect, it } from 'vitest';
import { parameterSource, type SourceFacts } from './paramSources';

const base: SourceFacts = {
  input: 'HeadYaw',
  output: 'ParamAngleX',
  enabled: true,
  provided: true,
  idleWeight: 0,
  pluginInputs: new Set(),
  animations: { motions: [], expressions: [] },
};
const idle = {
  file: 'motions/idle.motion3.json',
  idle: true,
  parameters: new Set(['ParamAngleX']),
};

describe('parameterSource', () => {
  it('is tracking by default, and nothing for a disabled rule', () => {
    expect(parameterSource(base)).toEqual({
      kind: 'tracking',
      text: 'Driven by tracking (HeadYaw).',
    });
    expect(parameterSource({ ...base, enabled: false }).kind).toBe('none');
    expect(parameterSource({ ...base, provided: false, idleWeight: 1 }).text).toBe(
      'Driven by tracking (HeadYaw); no face is found now, so it rests at its default.',
    );
  });

  it('names a plugin that injects the input', () => {
    expect(parameterSource({ ...base, pluginInputs: new Set(['HeadYaw']) }).kind).toBe('plugin');
  });

  it('puts tracking above the idle animation while it has a value', () => {
    const f: SourceFacts = { ...base, animations: { motions: [idle], expressions: [] } };
    expect(parameterSource(f)).toEqual({
      kind: 'tracking',
      text: 'Driven by tracking (HeadYaw); it overrides the idle animation idle.motion3.json.',
    });
    // No face: the idle animation shows, until tracking takes over again.
    expect(parameterSource({ ...f, provided: false, idleWeight: 1 })).toEqual({
      kind: 'idle',
      text: 'Driven by the idle animation idle.motion3.json; tracking takes over when a face is found.',
    });
    // During a handover, both ways.
    expect(parameterSource({ ...f, idleWeight: 0.5 }).text).toContain(
      'handing over from the idle animation',
    );
    expect(parameterSource({ ...f, provided: false, idleWeight: 0.5 }).text).toContain(
      'handing over to the idle animation',
    );
  });

  it('follows the order: tracking < one-shot animation < expression < physics', () => {
    const f: SourceFacts = {
      ...base,
      animations: {
        motions: [{ file: 'wave.motion3.json', idle: false, parameters: new Set(['ParamAngleX']) }],
        expressions: [],
      },
    };
    expect(parameterSource(f)).toEqual({
      kind: 'motion',
      text: 'Driven by the animation wave.motion3.json; it overrides tracking (HeadYaw).',
    });
    const exp = parameterSource({
      ...f,
      animations: {
        ...f.animations,
        expressions: [{ name: 'Smile', parameters: new Map([['ParamAngleX', 'Overwrite']]) }],
      },
    });
    expect(exp.kind).toBe('expression');
    expect(parameterSource({ ...f, physicsFrom: 'ParamAngleZ' }).kind).toBe('physics');
  });

  it('reports Add and Multiply expressions as adjustments', () => {
    const r = parameterSource({
      ...base,
      animations: {
        motions: [],
        expressions: [{ name: 'Tilt', parameters: new Map([['ParamAngleX', 'Add']]) }],
      },
    });
    expect(r.kind).toBe('tracking');
    expect(r.text).toBe('Driven by tracking (HeadYaw), adjusted by the expression Tilt.');
  });
});

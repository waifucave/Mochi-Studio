import { describe, expect, it } from 'vitest';
import { MemoryFileSet, openModel } from './modelFiles';
import { syntheticModelFiles } from '../../test/support/syntheticModel';
import {
  chooseDrivers,
  reflectedOutputs,
  writtenByExpressions,
  redirectToDrivers,
  trackingRedirects,
  type PhysicsFile,
  type PhysicsInput,
} from './physicsDrivers';

/** Mochi2D's `physicsInputs`, written out by hand: target -> [id, weight, reflect?]. */
type In = [id: string, weight: number, reflect?: boolean];
const inputs = (o: Record<string, In[]>): Map<string, PhysicsInput[]> =>
  new Map(
    Object.entries(o).map(([k, list]) => [
      k,
      list
        .map(([id, weight, reflect = false]) => ({ id, weight, reflect }))
        .sort((a, b) => b.weight - a.weight),
    ]),
  );

/** A parsed physics file (Mochi2D's PhysicsFile type), for the output flags. */
const physicsFile = (outputs: Array<[string, boolean]>): PhysicsFile => ({
  label: 'test',
  fps: 0,
  names: [],
  settings: outputs.map(([destination, reflect], i) => ({
    id: `S${i}`,
    inputs: [],
    outputs: [{ destination, vertexIndex: 1, scale: 1, weight: 100, type: 'Angle', reflect }],
    particles: [],
    position: { minimum: -10, default: 0, maximum: 10 },
    angle: { minimum: -10, default: 0, maximum: 10 },
  })),
});

describe('physics drivers', () => {
  it('finds the parameter that drives an overwritten one', () => {
    const d = chooseDrivers(
      inputs({
        ParamAngleX: [['AngleX', 100]],
        ParamBodyAngleX: [
          ['AngleX', 40],
          ['BodyAngleX', 60],
        ],
        // Hair follows the overwritten head angle: that input is skipped.
        ParamHairFront: [['ParamAngleX', 100]],
      }),
    );
    expect(d).toEqual({
      ParamAngleX: { from: 'AngleX', reflect: false },
      ParamBodyAngleX: { from: 'BodyAngleX', reflect: false },
    });
  });

  it("uses look-at's routing for its targets, whatever else writes them", () => {
    // DeepSeek-chan in the running app: look-at goes through
    // physics, so its routing lists AngleX for ParamAngleX. Those inputs are
    // what head tracking must drive, even though look-at writes them.
    const d = chooseDrivers(
      inputs({
        ParamAngleX: [
          ['AngleX', 100],
          ['ParamBreath', 2],
        ],
        ParamBodyAngleX: [
          ['PositionX', 60],
          ['LeanX', 80],
        ],
      }),
      {
        look: [
          { target: 'ParamAngleX', writes: 'AngleX' },
          { target: 'ParamBodyAngleX', writes: 'PositionX' },
          { target: 'ParamEyeBallX', writes: 'ParamEyeBallX' },
        ],
        avoid: new Set(['AngleX']),
      },
    );
    expect(d).toEqual({
      ParamAngleX: { from: 'AngleX', reflect: false },
      ParamBodyAngleX: { from: 'PositionX', reflect: false },
    });
  });

  it('skips inputs breath writes, and avoids those that expressions write', () => {
    // As on DeepSeek-chan's body Y: an expression writes the lean control,
    // breath writes ParamBreath; the tracking input is PositionY.
    const i = inputs({
      ParamBodyAngleY: [
        ['PositionY', 30],
        ['LeanInput', 68],
        ['ParamBreath', 2],
      ],
    });
    expect(chooseDrivers(i).ParamBodyAngleY!.from).toBe('LeanInput');
    expect(
      chooseDrivers(i, { skip: new Set(['ParamBreath']), avoid: new Set(['LeanInput']) })
        .ParamBodyAngleY,
    ).toEqual({ from: 'PositionY', reflect: false });
    // Breath's parameters are never used, even when nothing else is left.
    expect(chooseDrivers(i, { skip: new Set(['LeanInput', 'ParamBreath', 'PositionY']) })).toEqual(
      {},
    );
  });

  it('falls back to an input an expression writes when nothing else is left', () => {
    // An expression may well write a head angle.
    const i = inputs({ ParamAngleX: [['AngleX', 100]] });
    expect(chooseDrivers(i, { avoid: new Set(['AngleX']) }).ParamAngleX).toEqual({
      from: 'AngleX',
      reflect: false,
    });
  });

  it('never lets a motion disqualify a driver', async () => {
    // The synthetic model's motion animates ParamAngleZ and ParamAngleX; its
    // expression writes ParamCustom and ParamMouthForm.
    const set = new MemoryFileSet('test', Object.entries(syntheticModelFiles()));
    const m = await openModel(set);
    const avoid = await writtenByExpressions(m.files, m.manifest);
    expect([...avoid].sort()).toEqual(['ParamCustom', 'ParamMouthForm']);
    const i = inputs({
      ParamHeadOut: [
        ['ParamAngleZ', 50],
        ['ParamCustom', 80],
      ],
    });
    expect(chooseDrivers(i, { avoid }).ParamHeadOut!.from).toBe('ParamAngleZ');
  });

  it('honors reflected inputs and outputs', () => {
    const reflected = reflectedOutputs(
      physicsFile([
        ['ParamBodyAngleZ', false],
        ['ParamAngleY', true],
        ['ParamAngleZ', true],
      ]),
    );
    expect([...reflected].sort()).toEqual(['ParamAngleY', 'ParamAngleZ']);
    const d = chooseDrivers(
      inputs({
        ParamBodyAngleZ: [['PositionZ', 100, true]],
        ParamAngleY: [['AngleY', 100]],
        // Both reflected: they cancel.
        ParamAngleZ: [['AngleZ', 100, true]],
      }),
      { reflectedOutputs: reflected },
    );
    expect(d.ParamBodyAngleZ).toEqual({ from: 'PositionZ', reflect: true });
    expect(d.ParamAngleY).toEqual({ from: 'AngleY', reflect: true });
    expect(d.ParamAngleZ).toEqual({ from: 'AngleZ', reflect: false });
    // A reflected driver is written mirrored within its range.
    const ranges = new Map([
      ['ParamBodyAngleZ', { min: -10, max: 10 }],
      ['PositionZ', { min: -10, max: 10 }],
    ]);
    expect(redirectToDrivers({ ParamBodyAngleZ: 6 }, d, ranges)).toEqual({ PositionZ: -6 });
  });

  it('leaves ordinary models alone, and rules can opt out', () => {
    // The usual setup: the head angle drives the hair. Tracking writes the
    // head angle, so a rule on the hair is not moved onto the head.
    const d = chooseDrivers(inputs({ ParamHair: [['ParamAngleX', 100]] }));
    expect(d).toEqual({ ParamHair: { from: 'ParamAngleX', reflect: false } });
    expect(trackingRedirects(d, ['ParamAngleX', 'ParamHair'])).toEqual({});
    // DeepSeek-chan's setup: tracking's ParamAngleX goes to AngleX…
    const ds = { ParamAngleX: { from: 'AngleX', reflect: false } };
    expect(trackingRedirects(ds, ['ParamAngleX'])).toEqual(ds);
    // …unless the rule is switched to write ParamAngleX itself.
    expect(trackingRedirects(ds, ['ParamAngleX'], ['ParamAngleX'])).toEqual({});
  });

  it('moves values to the drivers, scaled between ranges', () => {
    const ranges = new Map([
      ['ParamAngleX', { min: -30, max: 30 }],
      ['AngleX', { min: -10, max: 10 }],
    ]);
    const d = { ParamAngleX: { from: 'AngleX', reflect: false } };
    expect(redirectToDrivers({ ParamAngleX: 15, ParamEyeLOpen: 1 }, d, ranges)).toEqual({
      AngleX: 5,
      ParamEyeLOpen: 1,
    });
    // Values for the same driver add up.
    expect(redirectToDrivers({ ParamAngleX: 30, AngleX: 1 }, d, ranges)).toEqual({ AngleX: 11 });
  });
});

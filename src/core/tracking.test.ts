import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CalibrationRecorder, applyCalibration } from './calibration';
import { matrixFromPose } from './headPose';
import { defaultRules } from './mapping';
import { DEFAULT_ONE_EURO } from './filter';
import { TrackingPipeline } from './pipeline';
import { parseRecording } from './recording';
import { deriveInputs, meanInput, readInput, type TrackingFrame } from './tracking';

const STANDARD = [
  'ParamAngleX',
  'ParamAngleY',
  'ParamAngleZ',
  'ParamBodyAngleX',
  'ParamBodyAngleY',
  'ParamBodyAngleZ',
  'ParamEyeLOpen',
  'ParamEyeROpen',
  'ParamEyeLSmile',
  'ParamEyeRSmile',
  'ParamEyeBallX',
  'ParamEyeBallY',
  'ParamBrowLY',
  'ParamBrowRY',
  'ParamCheek',
  'ParamMouthOpenY',
  'ParamMouthForm',
];

const frame = (bs: Record<string, number>, pose = {}): TrackingFrame => ({
  t: 0,
  face: true,
  blendshapes: bs,
  matrix: matrixFromPose(pose),
});

describe('deriveInputs', () => {
  it('derives eye openness, mouth and gaze', () => {
    const i = deriveInputs(
      frame({
        eyeBlinkLeft: 0.9,
        jawOpen: 0.5,
        eyeLookOutLeft: 0.6,
        eyeLookInRight: 0.6,
        mouthSmileLeft: 1,
        mouthSmileRight: 1,
      }),
      false,
    );
    expect(i.EyeOpenLeft).toBeCloseTo(0.1);
    expect(i.EyeOpenRight).toBe(1);
    expect(i.MouthOpen).toBe(0.5);
    expect(i.GazeX).toBeCloseTo(0.6);
    expect(i.MouthForm).toBe(1);
    expect(i['bs.jawOpen']).toBe(0.5);
  });

  it('mirrors sides and horizontal motion', () => {
    const f = frame(
      { eyeBlinkLeft: 1, browOuterUpRight: 0.8, jawLeft: 0.4 },
      { yaw: 20, roll: 10, pitch: 5 },
    );
    const plain = deriveInputs(f, false);
    const mirrored = deriveInputs(f, true);
    expect(mirrored.EyeOpenRight).toBe(plain.EyeOpenLeft);
    expect(mirrored.EyeOpenLeft).toBe(plain.EyeOpenRight);
    expect(mirrored.BrowLeftY).toBe(plain.BrowRightY);
    expect(mirrored['bs.jawRight']).toBe(0.4);
    expect(mirrored.HeadYaw).toBeCloseTo(-20);
    expect(mirrored.HeadRoll).toBeCloseTo(-10);
    expect(mirrored.HeadPitch).toBeCloseTo(5);
  });
});

describe('calibration', () => {
  it('removes the neutral offset and rescales unipolar inputs', () => {
    const rec = new CalibrationRecorder();
    rec.add({ HeadYaw: 4, EyeOpenLeft: 0.8, MouthOpen: 0.1 });
    rec.add({ HeadYaw: 6, EyeOpenLeft: 0.8, MouthOpen: 0.1 });
    const cal = rec.result();
    expect(cal.HeadYaw).toBe(5);
    const out = applyCalibration({ HeadYaw: 5, EyeOpenLeft: 0.8, MouthOpen: 0.1, Unknown: 3 }, cal);
    expect(out).toEqual({ HeadYaw: 0, EyeOpenLeft: 1, MouthOpen: 0, Unknown: 3 });
    expect(applyCalibration({ MouthOpen: 0.55 }, cal).MouthOpen).toBeCloseTo(0.5);
    expect(applyCalibration({ EyeOpenLeft: 0.4 }, cal).EyeOpenLeft).toBeCloseTo(0.5);
  });
});

describe('tracking pipeline on the recorded fixture', () => {
  const rec = parseRecording(
    readFileSync(new URL('../../test/fixtures/synthetic-session.json', import.meta.url), 'utf8'),
  );
  const make = (calibration = {}) =>
    new TrackingPipeline({
      mirror: true,
      filter: DEFAULT_ONE_EURO,
      calibration,
      mapping: defaultRules(STANDARD),
    });

  const run = (p: TrackingPipeline) =>
    rec.frames.map((f) => ({ t: f.t, face: f.face, v: p.step(f, f.t) }));
  const at = (out: ReturnType<typeof run>, s: number) => out.find((o) => o.t >= s * 1000)!;

  it('works a tracking frame out once, however often it is drawn', () => {
    // Each frame stepped twice, as at 60 frames drawn a second with tracking at 30: the
    // inputs are those of stepping it once (the mapping's own smoothing still moves on).
    const once = make();
    const twice = make();
    for (const f of rec.frames) {
      once.step(f, f.t);
      twice.step(f, f.t);
      const first = { ...twice.lastInputs };
      twice.step(f, f.t + 16);
      expect(twice.lastInputs).toEqual(first);
      expect(twice.lastInputs).toEqual(once.lastInputs);
    }
    // A new configuration is worked out afresh.
    const f = rec.frames.find((x) => x.face)!;
    once.step(f, f.t);
    const before = { ...once.lastInputs };
    once.configure({
      mirror: true,
      filter: DEFAULT_ONE_EURO,
      calibration: { HeadYaw: 5 },
      mapping: defaultRules(STANDARD),
    });
    once.step(f, f.t);
    expect(once.lastInputs.HeadYaw).toBeCloseTo(before.HeadYaw! - 5, 5);
  });

  it('calibrates the neutral pose to the centre', () => {
    const p = make();
    const recorder = new CalibrationRecorder();
    for (const f of rec.frames.filter((f) => f.t < 2000)) recorder.add(p.filteredInputs(f));
    const out = run(make(recorder.result()));
    const n = at(out, 1.5).v;
    expect(Math.abs(n.ParamAngleX!)).toBeLessThan(1.5);
    expect(Math.abs(n.ParamAngleY!)).toBeLessThan(1.5);
    expect(n.ParamEyeLOpen).toBeGreaterThan(0.95);
    expect(n.ParamMouthOpenY).toBeLessThan(0.05);
    // Without calibration the 2°/-3° offset of the neutral pose shows.
    const raw = at(run(make()), 1.5).v;
    expect(Math.abs(raw.ParamAngleY!)).toBeGreaterThan(2);
  });

  it('follows head turns, blinks, talking and smiling', () => {
    const out = run(make());
    expect(at(out, 2.5).v.ParamAngleX!).toBeLessThan(-15); // mirrored +25° yaw
    expect(at(out, 3.5).v.ParamAngleX!).toBeGreaterThan(15);
    expect(at(out, 4.15).v.ParamEyeLOpen!).toBeLessThan(0.2);
    const talking = out.filter((o) => o.t >= 5000 && o.t < 7000).map((o) => o.v.ParamMouthOpenY!);
    expect(Math.max(...talking)).toBeGreaterThan(0.6);
    expect(at(out, 7.5).v.ParamMouthForm!).toBeGreaterThan(0.8);
    expect(at(out, 7.5).v.ParamEyeLSmile!).toBeGreaterThan(0.5);
  });

  it('outputs nothing while the face is lost and recovers afterwards', () => {
    const out = run(make());
    expect(at(out, 8.2).v).toEqual({});
    expect(at(out, 9.5).v.ParamAngleY!).toBeGreaterThan(8);
  });

  it('keeps every output inside its rule range', () => {
    for (const o of run(make())) {
      for (const r of defaultRules(STANDARD)) {
        const v = o.v[r.output];
        if (v === undefined || r.output.startsWith('ParamBodyAngle')) continue;
        expect(v).toBeGreaterThanOrEqual(Math.min(r.outMin, r.outMax) - 1e-9);
        expect(v).toBeLessThanOrEqual(Math.max(r.outMin, r.outMax) + 1e-9);
      }
    }
  });
});

describe('readInput', () => {
  it('reads plain and averaged inputs', () => {
    const v = { a: 1, b: 0.5 };
    expect(readInput(v, 'a')).toBe(1);
    expect(readInput(v, meanInput(['a', 'b']))).toBe(0.75);
    expect(readInput(v, 'mean(a,zz)')).toBe(1);
    expect(readInput(v, 'mean(zz)')).toBeUndefined();
    expect(readInput(v, 'zz')).toBeUndefined();
  });
});

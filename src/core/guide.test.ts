import { describe, expect, it } from 'vitest';
import { guideComplete, guideSteps, type GuideState } from './guide';
import { cameraErrorMessage, microphoneErrorMessage, type MediaContext } from './mediaErrors';

const fresh: GuideState = {
  model: false,
  cameraOn: false,
  faceSeen: false,
  calibrated: false,
  outputViews: 0,
  bridgeReady: false,
  desktop: false,
};
const status = (s: GuideState) => guideSteps(s).map((x) => `${x.id}:${x.status}`);

describe('the first-run guide', () => {
  it('starts with loading a model', () => {
    expect(status(fresh)).toEqual(['model:current', 'camera:todo', 'calibrate:todo', 'obs:todo']);
  });

  it('moves on as each step is done', () => {
    const loaded = { ...fresh, model: true };
    expect(status(loaded)[1]).toBe('camera:current');
    // The camera counts once it has seen a face.
    const on = { ...loaded, cameraOn: true };
    expect(status(on)[1]).toBe('camera:current');
    expect(guideSteps(on)[1]!.detail).toMatch(/no face/);
    const seen = { ...on, faceSeen: true };
    expect(status(seen).slice(1, 3)).toEqual(['camera:done', 'calibrate:current']);
    const all = { ...seen, calibrated: true, outputViews: 1 };
    expect(guideComplete(all)).toBe(true);
  });

  it('explains OBS for the browser (the bridge) and for the desktop app', () => {
    const browser = guideSteps({ ...fresh, model: true })[3]!.detail;
    expect(browser).toMatch(/npm run bridge/);
    expect(browser).toMatch(/pairing code/);
    const desktop = guideSteps({ ...fresh, model: true, desktop: true })[3]!.detail;
    expect(desktop).not.toMatch(/npm run bridge/);
    expect(desktop).toMatch(/Browser Source/);
  });
});

describe('camera and microphone errors', () => {
  const browser: MediaContext = { desktop: false, secure: true, platform: 'windows' };
  const mac: MediaContext = { desktop: true, secure: true, platform: 'mac' };
  const err = (name: string) => Object.assign(new Error('raw'), { name });

  it('says how to allow a blocked camera, by place', () => {
    expect(cameraErrorMessage(err('NotAllowedError'), browser)).toMatch(/site settings/);
    expect(cameraErrorMessage(err('NotAllowedError'), mac)).toMatch(/Privacy & Security → Camera/);
  });

  it('names a missing or busy camera, and an insecure page', () => {
    expect(cameraErrorMessage(err('NotFoundError'), browser)).toMatch(/No camera/);
    expect(cameraErrorMessage(err('NotReadableError'), browser)).toMatch(/another app/);
    expect(cameraErrorMessage(err('NotAllowedError'), { ...browser, secure: false })).toMatch(
      /secure page/,
    );
    // Other failures keep their own message (for example the missing face model).
    expect(cameraErrorMessage(new Error('The face model is missing.'), browser)).toBe(
      'The face model is missing.',
    );
  });

  it("reads Mochi2D's microphone error codes", () => {
    const code = (c: string) => Object.assign(new Error('raw'), { code: c });
    expect(microphoneErrorMessage(code('denied'), browser)).toMatch(/site settings/);
    expect(microphoneErrorMessage(code('no-device'), browser)).toMatch(/No microphone/);
    expect(microphoneErrorMessage(code('busy'), browser)).toMatch(/another app/);
    expect(microphoneErrorMessage(code('no-lip-sync'), browser)).toMatch(/mouth parameter/);
    expect(microphoneErrorMessage(code('denied'), mac)).toMatch(/Privacy & Security → Microphone/);
  });
});

import { describe, expect, it } from 'vitest';
import {
  defaultLightOverlay,
  overlayFromFile,
  parseLightStrengths,
  parseScreenOverlay,
  strengthTint,
  LightSmoother,
  activeAverage,
  overlayColor,
  overlayInfo,
  overlayTint,
  parseLightOverlay,
  partAverages,
  DEFAULT_LIGHT_OVERLAY,
} from './lightOverlay';

/** A picture whose left, middle and right thirds are three colors. */
function thirds(w: number, h: number, cols: number[][]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = cols[Math.min(2, Math.floor((x * 3) / w))]!;
      d.set([...c, 255], (y * w + x) * 4);
    }
  return d;
}

describe('the display light overlay', () => {
  it('averages the three parts, and the active ones', () => {
    const parts = partAverages(
      thirds(48, 27, [
        [255, 0, 0],
        [0, 255, 0],
        [0, 0, 255],
      ]),
      48,
      27,
    );
    expect(parts).toEqual({ left: [255, 0, 0], middle: [0, 255, 0], right: [0, 0, 255] });
    expect(activeAverage(parts, { left: true, middle: true, right: true })).toEqual([85, 85, 85]);
    expect(activeAverage(parts, { left: true, middle: false, right: true })).toEqual([
      127.5, 0, 127.5,
    ]);
    // None on: white.
    expect(activeAverage(parts, { left: false, middle: false, right: false })).toEqual([
      255, 255, 255,
    ]);
  });

  it('gives the documented final color, at most 459, and a tint of at most 1', () => {
    expect(overlayColor([100, 0, 255], { colorBoost: 50, baseBrightness: 0 })).toEqual([
      100, 0, 255,
    ]);
    expect(overlayColor([100, 0, 255], { colorBoost: 100, baseBrightness: 50 })).toEqual([
      327.5, 127.5, 459,
    ]);
    // The whole range now (Mochi2D 0.14.0): up to 1.8.
    expect(overlayTint([327.5, 127.5, 51]).map((c) => Math.round(c * 1000) / 1000)).toEqual([
      1.284, 0.5, 0.2,
    ]);
    expect(overlayTint([459, 600, -3])).toEqual([1.8, 1.8, 0]);
  });

  it('smooths over smoothing / 30 seconds, and reads stored settings safely', () => {
    const s = new LightSmoother();
    expect(s.step([0, 0, 0], 0, 30)).toEqual([0, 0, 0]);
    const one = s.step([255, 255, 255], 1, 30)[0]!;
    expect(one).toBeCloseTo(255 * (1 - Math.exp(-1)), 3);
    expect(new LightSmoother().step([9, 9, 9], 0.1, 0)).toEqual([9, 9, 9]);
    expect(parseLightOverlay(undefined)).toEqual(DEFAULT_LIGHT_OVERLAY);
    expect(
      parseLightOverlay({
        baseBrightness: 140,
        smoothing: -3,
        parts: { middle: false },
        items: true,
      }),
    ).toEqual({
      ...DEFAULT_LIGHT_OVERLAY,
      baseBrightness: 100,
      smoothing: 0,
      parts: { left: true, middle: false, right: true },
      items: true,
    });
  });

  it('answers SceneColorOverlayInfoRequest: white while off, the state while on', () => {
    const off = overlayInfo(undefined, DEFAULT_LIGHT_OVERLAY);
    expect(off).toMatchObject({
      active: false,
      colorOverlayR: 255,
      colorAvgB: 255,
      leftCapturePart: { active: false, colorR: 255, colorG: 255, colorB: 255 },
      baseBrightness: 15,
      colorBoost: 40,
      smoothing: 3,
    });
    const settings = {
      ...DEFAULT_LIGHT_OVERLAY,
      parts: { left: true, middle: false, right: true },
    };
    const on = overlayInfo(
      {
        active: true,
        isWindowCapture: true,
        settings,
        parts: { left: [255, 0, 0], middle: [0, 255, 0], right: [0, 0, 255] },
        average: [127.5, 0, 127.5],
        overlay: [255, 127.5, 255],
      },
      settings,
    );
    expect(on).toMatchObject({
      active: true,
      isWindowCapture: true,
      middleCapturePart: { active: false, colorR: 0, colorG: 255, colorB: 0 },
      colorAvgR: 128,
      colorOverlayG: 128,
    });
  });
});

describe('the light overlay’s details', () => {
  it('has VTube Studio’s defaults', () => {
    expect(defaultLightOverlay()).toEqual({
      baseBrightness: 15,
      colorBoost: 40,
      smoothing: 3,
      parts: { left: true, middle: true, right: true },
      items: true,
      staticColor: [255, 255, 255],
    });
  });

  it('gives each art mesh its share of the light', () => {
    expect(strengthTint([0.5, 1.4, 1], 1)).toEqual([0.5, 1.4, 1]);
    expect(strengthTint([0.5, 1.4, 1], 0)).toEqual([1, 1, 1]);
    expect(strengthTint([0.5, 1.4, 1], 0.5).map((c) => Math.round(c * 100))).toEqual([
      75, 120, 100,
    ]);
    expect(parseLightStrengths({ A: 0.333, B: 1, C: -2, D: 'x', '': 0 })).toEqual({
      A: 0.33,
      C: 0,
    });
  });

  it('reads a Screen Overlay hotkey’s ColorOverlay from a file, and keeps it', () => {
    const file = {
      On: true,
      IsStaticColor: true,
      Display: -1,
      WindowName: '',
      IncludeLeft: true,
      IncludeMid: false,
      IncludeRight: true,
      BaseValue: 15,
      OverlayValue: 40,
      Smoothing: 3,
      IncludeItems: true,
      StaticColor: { r: 0.2724, g: 0.2464, b: 0.2612, a: 1 },
    };
    const a = overlayFromFile(file);
    expect(a).toMatchObject({
      on: true,
      source: 'static',
      settings: {
        baseBrightness: 15,
        colorBoost: 40,
        smoothing: 3,
        parts: { left: true, middle: false, right: true },
        items: true,
        staticColor: [69, 63, 67],
      },
      raw: file,
    });
    expect(overlayFromFile({ On: false }).on).toBe(false);
    expect(overlayFromFile({ On: true, WindowName: 'Game' })).toMatchObject({
      source: 'capture',
      windowName: 'Game',
    });
    // Stored and read back unchanged.
    expect(parseScreenOverlay(JSON.parse(JSON.stringify(a)))).toEqual(a);
    expect(parseScreenOverlay(undefined)).toMatchObject({ on: false, source: 'capture' });
  });
});

import { describe, expect, it } from 'vitest';
import {
  drawScale,
  parseSpout,
  parseSpoutConfig,
  spoutConfig,
  spoutPageUrl,
  spoutSenderName,
  spoutSize,
} from './spout';

describe('Spout2 output', () => {
  it('names senders after the app, numbered by output', () => {
    expect([0, 1, 2, 3].map(spoutSenderName)).toEqual([
      'MochiStudio',
      'MochiStudio2',
      'MochiStudio3',
      'MochiStudio4',
    ]);
  });

  it('reads stored settings safely', () => {
    expect(parseSpout(undefined)).toEqual({ outputs: [{ enabled: false, mirror: false }] });
    expect(
      parseSpout({
        outputs: [
          { enabled: true, mirror: 1, size: { width: 3, height: 99999 } },
          'x',
          { enabled: true, size: { width: 640 } },
          {},
          {},
          {},
        ],
      }),
    ).toEqual({
      outputs: [
        { enabled: true, mirror: false, size: { width: 16, height: 7680 } },
        { enabled: true, mirror: false },
        { enabled: false, mirror: false },
        { enabled: false, mirror: false },
      ],
    });
  });

  it('sends the stage size (even) unless a fixed size is set, and only the outputs that are on', () => {
    expect(spoutSize({ enabled: true, mirror: false }, { width: 1281, height: 719 })).toEqual({
      width: 1282,
      height: 720,
    });
    const c = spoutConfig(
      {
        outputs: [
          { enabled: true, mirror: false },
          { enabled: false, mirror: false },
          { enabled: true, mirror: true, size: { width: 1920, height: 1080 } },
        ],
      },
      { width: 1280, height: 720 },
      'http://127.0.0.1:47830/app/output.html',
      0,
    );
    expect(c).toEqual({
      page: 'http://127.0.0.1:47830/app/output.html',
      fps: 60,
      outputs: [
        { name: 'MochiStudio', width: 1280, height: 720, mirror: false },
        { name: 'MochiStudio3', width: 1920, height: 1080, mirror: true },
      ],
    });
    expect(spoutPageUrl(c.page, c.outputs[1]!)).toBe(
      'http://127.0.0.1:47830/app/output.html?transparent=1&spout=MochiStudio3&mirror=1',
    );
  });

  it('accepts only the app’s own output page and its sender names (the main process’s check)', () => {
    const origin = 'http://127.0.0.1:47830';
    const ok = {
      page: `${origin}/app/output.html`,
      fps: 90,
      outputs: [
        { name: 'MochiStudio', width: 640, height: 360 },
        { name: 'MochiStudio', width: 640, height: 360 },
        { name: 'OtherApp', width: 640, height: 360 },
        { name: 'MochiStudio2', width: 99999, height: 360, mirror: true },
      ],
      path: 'readback',
    };
    expect(parseSpoutConfig(ok, origin)).toEqual({
      page: `${origin}/app/output.html`,
      fps: 60,
      outputs: [
        { name: 'MochiStudio', width: 640, height: 360, mirror: false },
        { name: 'MochiStudio2', width: 7680, height: 360, mirror: true },
      ],
      path: 'readback',
    });
    expect(parseSpoutConfig({ ...ok, page: 'https://example.com/app/output.html' }, origin)).toBe(
      undefined,
    );
    expect(parseSpoutConfig({ ...ok, page: `${origin}/app/index.html` }, origin)).toBe(undefined);
  });

  it('draws an output larger than the screen at a whole scale that keeps its exact size', () => {
    const area = { width: 1024, height: 720 };
    expect(drawScale({ width: 640, height: 360 }, area)).toBe(1);
    expect(drawScale({ width: 1920, height: 1080 }, area)).toBe(2);
    expect(drawScale({ width: 3840, height: 2160 }, area)).toBe(4);
    expect(drawScale({ width: 1921, height: 1081 }, area)).toBe(2);
  });
});

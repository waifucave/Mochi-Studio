import { describe, expect, it } from 'vitest';
import { motionSoundPaths, sharedSoundNote } from './sharedModel';

const enc = new TextEncoder();
const settings = (motions: unknown) =>
  new Map([
    [
      'M/m.model3.json',
      enc.encode(JSON.stringify({ FileReferences: { Moc: 'm.moc3', Motions: motions } })),
    ],
  ]);

describe('a shared model’s motion sounds', () => {
  it('lists each sound its settings name once', () => {
    expect(
      motionSoundPaths(
        settings({
          Idle: [{ File: 'a.motion3.json', Sound: 's/hi.mp3' }, { File: 'b.motion3.json' }],
          Tap: [
            { File: 'c.motion3.json', Sound: 's/hi.mp3' },
            { File: 'd', Sound: 's/yo.wav' },
          ],
        }),
      ),
    ).toEqual(['s/hi.mp3', 's/yo.wav']);
    expect(motionSoundPaths(new Map([['M/m.model3.json', enc.encode('{')]]))).toEqual([]);
  });

  it('tells the receiver they don’t play here, whatever their format', () => {
    expect(sharedSoundNote(settings({ Idle: [{ File: 'a', Sound: 'hi.ogg' }] }))).toBe(
      'Their model’s motion sounds don’t play here (“hi.ogg”): a shared model plays none of its own sounds.',
    );
    expect(sharedSoundNote(settings({ Idle: [{ File: 'a' }] }))).toBeUndefined();
  });
});

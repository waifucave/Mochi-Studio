import type { TrackingFrame } from './tracking';

/**
 * A recorded tracking session: blendshape values and head matrices only,
 * never camera images. Used as test fixtures and for debugging mappings.
 */
export interface TrackingRecording {
  format: 'mochi-studio/tracking-recording';
  version: 1;
  /** Free text: who recorded it and how, or that it is synthetic. */
  source: string;
  frames: TrackingFrame[];
}

export function parseRecording(json: string): TrackingRecording {
  const raw = JSON.parse(json) as Partial<TrackingRecording>;
  if (
    raw.format !== 'mochi-studio/tracking-recording' ||
    raw.version !== 1 ||
    !Array.isArray(raw.frames)
  )
    throw new Error('Not a Mochi Studio tracking recording.');
  return raw as TrackingRecording;
}

/** Replays a recording at its own timing. */
export function* replay(rec: TrackingRecording): Generator<TrackingFrame> {
  yield* rec.frames;
}

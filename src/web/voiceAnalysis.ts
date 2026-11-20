/**
 * The advanced lipsync's analysis of a microphone stream:
 * Mochi2D's `VowelAnalyzer` (its own audio analysis, as motion sync uses)
 * on the latest 32 ms of the stream, once a frame. It gives the element
 * weights (Silence, A, I, U, E, O) and how open the level makes the mouth,
 * for the voice inputs. Audio stays in memory: nothing is kept or sent.
 *
 * The stream is analyzed at 16 kHz, Mochi2D's analysis rate: an audio
 * context at that rate resamples it, or (where a browser cannot) a simple
 * low-pass and interpolation does.
 */
import {
  ANALYSIS_RATE,
  ANALYSIS_WINDOW,
  VowelAnalyzer,
  voiceProfileFromJson,
  type VoiceProfile,
} from 'mochi2d/headless';
import type { StoredVoiceProfile, VoiceReading } from '../core/voice';
import { VOICE_ELEMENTS } from '../core/voice';

export class VoiceAnalysis {
  private ctx: AudioContext | undefined;
  private source: MediaStreamAudioSourceNode | undefined;
  private analyser: AnalyserNode | undefined;
  private raw = new Float32Array(0);
  private window = new Float32Array(ANALYSIS_WINDOW);
  private analyzer: VowelAnalyzer;
  private profileValue: VoiceProfile | null = null;
  private gateValue: number | undefined;
  /** Multiplies the samples before the analysis (the lipsync's sensitivity). */
  gain = 1;
  /** The latest reading. */
  reading: VoiceReading | undefined;

  constructor(profile?: StoredVoiceProfile, gate?: number) {
    this.profileValue = usableProfile(profile);
    this.gateValue = gate;
    this.analyzer = this.makeAnalyzer();
  }

  private makeAnalyzer(): VowelAnalyzer {
    return new VowelAnalyzer({
      profile: this.profileValue,
      ...(this.gateValue !== undefined ? { gate: this.gateValue } : {}),
    });
  }

  /** A voice profile (undefined: Mochi2D's neutral voice), and the gate in dBFS. */
  configure(profile: StoredVoiceProfile | undefined, gate: number | undefined): void {
    const p = usableProfile(profile);
    if (p === this.profileValue && gate === this.gateValue) return;
    this.profileValue = p;
    this.gateValue = gate;
    this.analyzer = this.makeAnalyzer();
  }

  get running(): boolean {
    return !!this.analyser;
  }

  async start(stream: MediaStream): Promise<void> {
    this.stop();
    let ctx: AudioContext;
    let source: MediaStreamAudioSourceNode;
    try {
      ctx = new AudioContext({ sampleRate: ANALYSIS_RATE });
      source = ctx.createMediaStreamSource(stream);
    } catch {
      // A browser that cannot resample a stream into another rate.
      ctx = new AudioContext();
      source = ctx.createMediaStreamSource(stream);
    }
    const analyser = ctx.createAnalyser();
    let size = 512;
    while (size < (ANALYSIS_WINDOW * ctx.sampleRate) / ANALYSIS_RATE + 8) size *= 2;
    analyser.fftSize = size;
    source.connect(analyser);
    this.ctx = ctx;
    this.source = source;
    this.analyser = analyser;
    this.raw = new Float32Array(size);
    this.analyzer.reset();
    await ctx.resume().catch(() => undefined);
  }

  stop(): void {
    this.source?.disconnect();
    void this.ctx?.close().catch(() => undefined);
    this.ctx = undefined;
    this.source = undefined;
    this.analyser = undefined;
    this.reading = undefined;
  }

  /** Analyzes the latest window, `dt` seconds after the last; undefined while stopped. */
  step(dt: number): VoiceReading | undefined {
    const a = this.analyser;
    const ctx = this.ctx;
    if (!a || !ctx) return undefined;
    a.getFloatTimeDomainData(this.raw);
    const w = this.window;
    if (ctx.sampleRate === ANALYSIS_RATE) w.set(this.raw.subarray(this.raw.length - w.length));
    else resampleTail(this.raw, ctx.sampleRate, w);
    if (this.gain !== 1) for (let i = 0; i < w.length; i++) w[i]! *= this.gain;
    const r = this.analyzer.analyze(w, 0, Math.max(0.001, dt));
    const weights = {} as VoiceReading['weights'];
    VOICE_ELEMENTS.forEach((e, i) => (weights[e] = r.raw[i] ?? 0));
    this.reading = { weights, volume: r.open, level: r.level, silent: r.silent };
    return this.reading;
  }
}

/** A stored profile as Mochi2D takes it, when it has every vowel; null otherwise (the neutral voice). */
export function usableProfile(p: StoredVoiceProfile | undefined): VoiceProfile | null {
  if (!p) return null;
  if (!['A', 'I', 'U', 'E', 'O'].every((v) => (p.templates[v as 'A']?.length ?? 0) > 0))
    return null;
  try {
    return voiceProfileFromJson(JSON.parse(JSON.stringify(p)));
  } catch {
    return null;
  }
}

/**
 * The last `out.length` samples at 16 kHz of `input` at `rate`: each output
 * sample is the mean of the input samples around it (a box low-pass as wide
 * as one output sample), read with linear interpolation.
 */
function resampleTail(input: Float32Array, rate: number, out: Float32Array): void {
  const step = rate / ANALYSIS_RATE;
  const end = input.length - 1;
  const half = step / 2;
  for (let k = 0; k < out.length; k++) {
    const centre = end - (out.length - 1 - k) * step;
    const lo = Math.max(0, Math.ceil(centre - half));
    const hi = Math.min(end, Math.floor(centre + half));
    let sum = 0;
    let n = 0;
    for (let i = lo; i <= hi; i++) {
      sum += input[i]!;
      n++;
    }
    out[k] = n ? sum / n : (input[Math.max(0, Math.min(end, Math.round(centre)))] ?? 0);
  }
}

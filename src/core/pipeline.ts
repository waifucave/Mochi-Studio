import { applyCalibration, type Calibration } from './calibration';
import { ChannelFilters, type OneEuroParams } from './filter';
import { MappingEngine, type MappingRule } from './mapping';
import { HAND_FLAGS, handInputs } from './hands';
import { deriveInputs, type InputValues, type TrackingFrame } from './tracking';
import { combinedVoiceInputs, type FrequencyWeights } from './voice';

export const MOUTH_PARAM = 'ParamMouthOpenY';

/** Values plugins inject into inputs (src/core/plugins/injection.ts). */
export interface InputInjector {
  active(t: number): boolean;
  apply(inputs: InputValues, t: number): { inputs: InputValues };
}

export interface PipelineConfig {
  mirror: boolean;
  filter: OneEuroParams;
  calibration: Calibration;
  mapping: MappingRule[];
  /** The weights of `VoiceFrequency` (src/core/voice.ts); the defaults without them. */
  frequencyWeights?: FrequencyWeights;
}

/**
 * Tracking frame -> inputs -> One Euro filter -> calibration -> mapping ->
 * parameter values. Pure apart from filter state.
 */
export class TrackingPipeline {
  private filters: ChannelFilters;
  /** The hand inputs' own filters (hands come and go apart from the face). */
  private handFilters: ChannelFilters;
  private lastHands = '';
  private engine: MappingEngine;
  /** The last calibrated inputs (for the editor's live values). */
  lastInputs: InputValues = {};
  private lastFace = false;
  /**
   * The last tracking frame's inputs: frames are drawn
   * up to 60 times a second, tracking comes 30 times, and the same frame
   * gives the same values (a filter given no newer time returns its last
   * value), so they are worked out once per tracking frame.
   */
  private faceCache: { frame: TrackingFrame; cfg: PipelineConfig; inputs: InputValues } | undefined;
  private handCache: { frame: TrackingFrame; cfg: PipelineConfig; inputs: InputValues } | undefined;

  constructor(private cfg: PipelineConfig) {
    this.filters = new ChannelFilters(cfg.filter);
    this.handFilters = new ChannelFilters(cfg.filter);
    this.engine = new MappingEngine(cfg.mapping);
  }

  configure(cfg: PipelineConfig): void {
    this.cfg = cfg;
    this.filters.setParams(cfg.filter);
    this.handFilters.setParams(cfg.filter);
    this.engine.setRules(cfg.mapping);
  }

  /** A frame's hand inputs, filtered; a hand that comes back starts its filters afresh. */
  private handValues(frame: TrackingFrame): InputValues {
    const raw = handInputs(frame.hands ?? [], this.cfg.mirror);
    const found = `${raw.HandLeftFound}${raw.HandRightFound}`;
    if (found !== this.lastHands) this.handFilters.reset();
    this.lastHands = found;
    const flags: InputValues = {};
    const rest: InputValues = {};
    for (const [k, v] of Object.entries(raw)) (HAND_FLAGS.has(k) ? flags : rest)[k] = v;
    return { ...this.handFilters.apply(rest, frame.t), ...flags };
  }

  /** Filtered, uncalibrated inputs: what the calibration recorder samples. */
  filteredInputs(frame: TrackingFrame): InputValues {
    return this.filters.apply(deriveInputs(frame, this.cfg.mirror), frame.t);
  }

  /**
   * @param frame the latest tracking frame, or undefined when tracking is off
   * @param t milliseconds
   * @returns the mapped parameter values; empty without a face. The mouth is
   *   mixed with lip sync afterwards (`mixMouth`), because Mochi2D adds its
   *   live lip sync on top of the base value.
   */
  /**
   * One frame: the tracked inputs (with a face), the advanced lipsync's
   * voice inputs (`voice`, while it runs, face or not), then plugins' values,
   * through the mappings.
   */
  step(
    frame: TrackingFrame | undefined,
    t: number,
    plugins?: InputInjector,
    voice?: InputValues,
    others?: InputValues,
  ): Record<string, number> {
    const face = !!frame?.face;
    let params: Record<string, number> = {};
    let inputs: InputValues | undefined;
    if (frame && face) {
      if (!this.lastFace) {
        this.filters.reset();
        this.engine.reset();
        this.faceCache = undefined;
      }
      const c = this.faceCache;
      if (c && c.frame === frame && c.cfg === this.cfg) inputs = { ...c.inputs };
      else {
        const v = applyCalibration(this.filteredInputs(frame), this.cfg.calibration);
        this.faceCache = { frame, cfg: this.cfg, inputs: v };
        inputs = { ...v };
      }
    }
    // Hands, face or not: filtered like the face, the found flags as they are.
    if (frame?.hands) {
      const c = this.handCache;
      const hands =
        c && c.frame === frame && c.cfg === this.cfg ? c.inputs : this.handValues(frame);
      this.handCache = { frame, cfg: this.cfg, inputs: hands };
      inputs = { ...(inputs ?? {}), ...hands };
    }
    if (voice) inputs = { ...(inputs ?? {}), ...voice };
    // Other sources: the mouse and the controller, face or not.
    if (others && Object.keys(others).length) inputs = { ...(inputs ?? {}), ...others };
    // The combined voice inputs, from the voice and the tracked mouth (src/core/voice.ts).
    if (inputs) Object.assign(inputs, combinedVoiceInputs(inputs, this.cfg.frequencyWeights));
    // Plugins' values replace or add to the tracked inputs, before the
    // mappings and their smoothing; they also work without a face.
    if (plugins?.active(t)) inputs = plugins.apply(inputs ?? {}, t).inputs;
    if (inputs) {
      this.lastInputs = inputs;
      params = this.engine.evaluate(inputs, t);
    }
    this.lastFace = face;
    return params;
  }
}

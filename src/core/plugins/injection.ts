/**
 * Values plugins inject into input parameters.
 *
 * - **Set mode:** one plugin at a time owns a parameter. Its value replaces
 *   the tracked one, blended by its weight: weight · injected + (1 − weight)
 *   · tracked (the natural reading; not documented).
 * - **Add mode:** any number of plugins add to a parameter; weights are
 *   ignored. Assumed (not documented): each plugin's latest add per parameter
 *   counts, until it sends another or one second passes, and adds come after
 *   the set-mode blend, before the mapping's smoothing.
 * - **Keep-alive:** an entry not renewed for one second is dropped, which
 *   also releases a set-mode lock. A session's entries end with it.
 * - **faceFound: true** counts the face as found for one second (assumed,
 *   not documented); false has no effect.
 *
 * Values arrive in protocol units and are kept in Mochi Studio's units
 * (`scale · value + offset`), so they can stand in for tracked inputs.
 */
import { E, validParameterNumber, type PluginAnswer, type PluginCaller } from './protocol';

export const KEEP_ALIVE_MS = 1000;

/** How a parameter name reaches a Mochi Studio input. */
export interface ResolvedParameter {
  input: string;
  scale: number;
  offset: number;
  /** In Mochi Studio units: the value without tracking. */
  rest: number;
}

interface SetEntry {
  pluginId: string;
  session: string;
  value: number;
  weight: number;
  at: number;
  /** In protocol units, for the plugin reading its own value. */
  raw: number;
  name: string;
}
interface AddEntry {
  pluginId: string;
  session: string;
  value: number;
  at: number;
}

export interface Injected {
  /** The inputs with injected values applied. */
  inputs: Record<string, number>;
  /** A plugin asserted the face is found. */
  faceFound: boolean;
}

export class InjectionState {
  private sets = new Map<string, SetEntry>();
  private adds = new Map<string, Map<string, AddEntry>>();
  private faceUntil = 0;
  private rests = new Map<string, number>();

  /** Handles an InjectParameterDataRequest's data. */
  inject(
    caller: PluginCaller,
    data: Record<string, unknown>,
    resolve: (name: string) => ResolvedParameter | undefined,
    now: number,
  ): PluginAnswer {
    this.expire(now);
    const mode = data.mode ?? 'set';
    if (mode !== 'set' && mode !== 'add')
      return { errorID: E.injectUnknownMode, message: 'mode must be "set" or "add".' };
    const list = data.parameterValues;
    if (!Array.isArray(list) || list.length === 0)
      return { errorID: E.injectNoData, message: 'parameterValues must list at least one value.' };
    const checked: Array<{ name: string; p: ResolvedParameter; value: number; weight: number }> =
      [];
    for (const raw of list) {
      const e = (raw ?? {}) as Record<string, unknown>;
      const name = typeof e.id === 'string' ? e.id : '';
      const p = name ? resolve(name) : undefined;
      if (!p)
        return {
          errorID: E.injectUnknownParameter,
          message: `Unknown parameter "${name}". InputParameterListRequest lists them.`,
        };
      if (!validParameterNumber(e.value))
        return {
          errorID: E.injectInvalidValue,
          message: `The value of "${name}" must be a number from -1000000 to 1000000.`,
        };
      const weight = e.weight === undefined ? 1 : e.weight;
      if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0 || weight > 1)
        return {
          errorID: E.injectInvalidWeight,
          message: `The weight of "${name}" must be a number from 0 to 1.`,
        };
      if (mode === 'set') {
        const owner = this.sets.get(p.input);
        if (owner && owner.pluginId !== caller.id)
          return {
            errorID: E.injectOtherPlugin,
            message: `Another plugin is setting "${name}" now.`,
          };
      }
      checked.push({ name, p, value: e.value, weight });
    }
    for (const { name, p, value, weight } of checked) {
      this.rests.set(p.input, p.rest);
      if (mode === 'set')
        this.sets.set(p.input, {
          pluginId: caller.id,
          session: caller.session,
          value: p.scale * value + p.offset,
          weight,
          at: now,
          raw: value,
          name,
        });
      else {
        let m = this.adds.get(p.input);
        if (!m) this.adds.set(p.input, (m = new Map()));
        m.set(caller.session, {
          pluginId: caller.id,
          session: caller.session,
          value: p.scale * value,
          at: now,
        });
      }
    }
    if (data.faceFound === true) this.faceUntil = now + KEEP_ALIVE_MS;
    return { data: {} };
  }

  /** Ends a session: its values and locks go at once. */
  endSession(session: string): void {
    for (const [k, e] of this.sets) if (e.session === session) this.sets.delete(k);
    for (const m of this.adds.values()) m.delete(session);
  }

  /** Ends everything a plugin injected (it was revoked). */
  endPlugin(pluginId: string): void {
    for (const [k, e] of this.sets) if (e.pluginId === pluginId) this.sets.delete(k);
    for (const m of this.adds.values())
      for (const [s, e] of m) if (e.pluginId === pluginId) m.delete(s);
  }

  private expire(now: number): void {
    for (const [k, e] of this.sets) if (now - e.at > KEEP_ALIVE_MS) this.sets.delete(k);
    for (const [k, m] of this.adds) {
      for (const [s, e] of m) if (now - e.at > KEEP_ALIVE_MS) m.delete(s);
      if (!m.size) this.adds.delete(k);
    }
  }

  /** Whether anything is injected now (the pipeline then runs without a face too). */
  active(now: number): boolean {
    this.expire(now);
    return this.sets.size > 0 || this.adds.size > 0;
  }

  /** The tracking inputs plugins set or add to now, with the plugin that does (the latest). */
  injectedInputs(now: number): Map<string, string> {
    this.expire(now);
    const out = new Map<string, string>();
    for (const [k, m] of this.adds) for (const e of m.values()) out.set(k, e.pluginId);
    for (const [k, e] of this.sets) out.set(k, e.pluginId);
    return out;
  }

  faceFound(now: number): boolean {
    return now < this.faceUntil;
  }

  /** The tracked inputs with the injected values applied. */
  apply(tracked: Record<string, number>, now: number): Injected {
    this.expire(now);
    const inputs = { ...tracked };
    for (const [id, e] of this.sets) {
      const base = inputs[id] ?? this.rests.get(id) ?? 0;
      inputs[id] = e.weight * e.value + (1 - e.weight) * base;
    }
    for (const [id, m] of this.adds) {
      let sum = 0;
      for (const e of m.values()) sum += e.value;
      inputs[id] = (inputs[id] ?? this.rests.get(id) ?? 0) + sum;
    }
    return { inputs, faceFound: this.faceFound(now) };
  }

  /** A plugin's own set-mode value of a parameter (protocol units), which it may always read. */
  ownValue(pluginId: string, input: string, now: number): number | undefined {
    this.expire(now);
    const e = this.sets.get(input);
    return e && e.pluginId === pluginId ? e.raw : undefined;
  }
}

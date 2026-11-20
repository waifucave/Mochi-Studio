/**
 * Input parameters as plugins see them: the default ones, named
 * as in the protocol and mapped to Mochi Studio's tracking inputs, and the
 * custom ones plugins create. Both reach the model through the mappings.
 */
import { FACE_INPUTS, UNSUPPORTED_INPUTS } from '../defaultInputs';
import { inputInfo, restValue } from '../tracking';
import { DEFAULT_PARAMETER_NAMES } from './protocol';

export interface DefaultParameter {
  /** The protocol name (`FaceAngleX`). */
  name: string;
  /** Mochi Studio's input id it reads and writes. */
  input: string;
  /** Mochi Studio value = scale · protocol value + offset. */
  scale: number;
  offset: number;
  /** In protocol units. */
  min: number;
  max: number;
  defaultValue: number;
  /** Mochi Studio tracks it (the camera); false for names it has no tracker for. */
  tracked: boolean;
}

/** The mapping input of a custom parameter, or of a default one Mochi Studio does not track. */
export const pluginInputId = (name: string): string => `plugin.${name}`;
export const isPluginInput = (id: string): boolean => id.startsWith('plugin.');

function build(): DefaultParameter[] {
  const out: DefaultParameter[] = [];
  // In the protocol's order, whether Mochi Studio tracks them or not.
  for (const name of DEFAULT_PARAMETER_NAMES) {
    const conv = FACE_INPUTS[name];
    if (!conv) {
      if (name in UNSUPPORTED_INPUTS)
        out.push({
          name,
          input: pluginInputId(name),
          scale: 1,
          offset: 0,
          min: 0,
          max: 1,
          defaultValue: 0,
          tracked: false,
        });
      continue;
    }
    const info = inputInfo(conv.input);
    const toProtocol = (v: number): number => (v - conv.offset) / conv.scale;
    const lo = toProtocol(info?.min ?? 0);
    const hi = toProtocol(info?.max ?? 1);
    const rest = info ? restValue(info) : 0;
    out.push({
      name,
      input: conv.input,
      scale: conv.scale,
      offset: conv.offset,
      min: Math.min(lo, hi),
      max: Math.max(lo, hi),
      defaultValue: toProtocol(rest),
      tracked: true,
    });
  }
  return out;
}

export const DEFAULT_PARAMETERS: readonly DefaultParameter[] = build();
const BY_NAME = new Map(DEFAULT_PARAMETERS.map((p) => [p.name.toLowerCase(), p] as const));

/** A default parameter by protocol name (ignoring case: a custom name may not differ only in case). */
export function defaultParameter(name: string): DefaultParameter | undefined {
  return BY_NAME.get(name.toLowerCase());
}

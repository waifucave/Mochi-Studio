/**
 * What drives a parameter now, for the mapping list:
 * "my model doesn't move" is the top setup question.
 *
 * Mochi Studio's own order, lowest first, as it evaluates a frame (this
 * module only reports it; tracking wins over the idle animation):
 *
 * 1. the idle animation, while no tracked value or plugin value arrives;
 * 2. tracking, or a plugin's injected tracking input: the mapping writes the
 *    parameter's base value, and keeps the idle animation off it (Mochi2D's
 *    idle weights), with a faded handover each way (src/core/idleHandover.ts);
 * 3. a one-shot motion: Mochi2D applies it over the base value;
 * 4. an expression: Overwrite replaces the value, Add and Multiply adjust it;
 * 5. physics: it overwrites the parameters it drives every frame.
 */

export type SourceKind = 'tracking' | 'plugin' | 'idle' | 'motion' | 'expression' | 'physics';

export interface ActiveAnimations {
  /** Playing motions, oldest first, with the parameters their curves write. */
  motions: ReadonlyArray<{ file: string; idle: boolean; parameters: ReadonlySet<string> }>;
  /** Active expressions, oldest first, with each parameter's blend. */
  expressions: ReadonlyArray<{
    name: string;
    parameters: ReadonlyMap<string, 'Add' | 'Multiply' | 'Overwrite'>;
  }>;
}

export interface SourceFacts {
  /** The rule's input and output parameter. */
  input: string;
  output: string;
  enabled: boolean;
  /** The rule's input has a value now: a face is tracked, or a plugin sends it. */
  provided: boolean;
  /**
   * The idle weight of the parameter the rule writes: 0 while tracking has
   * it, 1 when the idle animation applies as usual, in between during a
   * handover.
   */
  idleWeight: number;
  /** The rule writes the physics input instead (physics overwrites the output). */
  redirectedTo?: string;
  /** Physics overwrites the output, from this input. */
  physicsFrom?: string;
  /** Inputs plugins drive now. */
  pluginInputs: ReadonlySet<string>;
  animations: ActiveAnimations;
}

export interface ParameterSource {
  /** The source that decides the value, or none (the parameter stays at its default). */
  kind: SourceKind | 'none';
  /** One line for the mapping list. */
  text: string;
}

const fileName = (p: string): string => p.split('/').pop() ?? p;

type Layer = { kind: SourceKind; label: string };

export function parameterSource(f: SourceFacts): ParameterSource {
  /** Sources that set the value, lowest first. */
  const layers: Layer[] = [];
  const adjust: string[] = [];
  const plugin = f.pluginInputs.has(f.input) || f.input.startsWith('plugin.');
  const track: Layer | undefined = f.enabled
    ? plugin
      ? { kind: 'plugin', label: `a plugin (${f.input})` }
      : { kind: 'tracking', label: `tracking (${f.input})` }
    : undefined;
  const touches = f.animations.motions.filter((m) => m.parameters.has(f.output));
  const idle: Layer[] = touches
    .filter((m) => m.idle)
    .map((m) => ({ kind: 'idle', label: `the idle animation ${fileName(m.file)}` }));
  // Tracking wins over the idle animation while it has a value; without one, the idle animation shows.
  const tracking = !!track && f.provided;
  if (tracking) layers.push(...idle, track!);
  else layers.push(...(track ? [track] : []), ...idle);
  const handing = idle.length > 0 && !!track && f.idleWeight > 0 && f.idleWeight < 1;
  for (const m of touches)
    if (!m.idle) layers.push({ kind: 'motion', label: `the animation ${fileName(m.file)}` });
  for (const e of f.animations.expressions) {
    const blend = e.parameters.get(f.output);
    if (blend === 'Overwrite')
      layers.push({ kind: 'expression', label: `the expression ${e.name}` });
    else if (blend) adjust.push(`the expression ${e.name}`);
  }
  if (f.physicsFrom)
    layers.push({
      kind: 'physics',
      label:
        f.redirectedTo && f.enabled
          ? `physics (from ${f.physicsFrom}, which this rule writes)`
          : `physics (from ${f.physicsFrom})`,
    });
  const top = layers.pop();
  if (!top)
    return {
      kind: adjust.length ? 'expression' : 'none',
      text: adjust.length
        ? `Driven by ${adjust.join(' and ')} (from its default value).`
        : 'Nothing drives it now: it stays at its default value.',
    };
  let text = `Driven by ${top.label}`;
  if (adjust.length && top.kind !== 'physics') text += `, adjusted by ${adjust.join(' and ')}`;
  const notes: string[] = [];
  // Tracking without a value overrides nothing.
  const below = layers
    .filter((l) => l !== track || f.provided)
    .reverse()
    .map((l) => l.label);
  if (below.length) notes.push(`it overrides ${below.join(', ')}`);
  if (track && !f.provided) {
    if (top === track)
      notes.push(
        plugin
          ? 'the plugin sends no value now, so it rests at its default'
          : 'no face is found now, so it rests at its default',
      );
    else if (top.kind === 'idle')
      notes.push(
        plugin
          ? 'the plugin takes over when it sends values'
          : 'tracking takes over when a face is found',
      );
  }
  if (handing)
    notes.push(
      tracking ? 'handing over from the idle animation' : 'handing over to the idle animation',
    );
  return { kind: top.kind, text: `${text}${notes.length ? `; ${notes.join('; ')}` : ''}.` };
}

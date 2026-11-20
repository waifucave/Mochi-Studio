/**
 * Import of a model's VTube Studio settings (`<name>.vtube.json`, and its
 * companion `items_pinned_to_model.json`) into Mochi Studio's own settings.
 *
 * The only source for the file format is a specification of it, written
 * for compatibility. The import is a one-way conversion. It returns the converted
 * settings and a report of what was imported, what was skipped and why,
 * which fields were unknown, and which choices are assumed.
 *
 * Every behavior the format leaves open gets a default here, marked
 * "Assumed" in the code and in the report. The result is ordinary Mochi
 * Studio settings, so everything stays adjustable in the mapping and hotkey
 * editors.
 */
import {
  importedGestureNames,
  keepImportedGesture,
  normalizeCombo,
  type Hotkey,
  type HotkeyAction,
} from '../hotkeys';
import { makeRule, type MappingRule } from '../mapping';
import { meanInput } from '../tracking';
import { FACE_INPUTS, UNSUPPORTED_INPUTS, same } from '../defaultInputs';
import { missingSource } from '../knownInputs';
import type { ModelManifest } from '../modelFiles';
import type { ModelSettings } from '../settings';
import { parsePhysicsTuning } from '../physicsTuning';
import { overlayFromFile, parseLightStrengths } from '../lightOverlay';

export interface ImportReport {
  /** Short lines describing what was converted. */
  imported: string[];
  /** Entries left out, with the reason. */
  skipped: Array<{ what: string; reason: string }>;
  /** Fields this importer does not know (ignored), as paths. */
  unknownFields: string[];
  /** Defaults chosen where the format's meaning is unknown. */
  assumed: string[];
  /** The app version that last saved the file, when given. */
  savedBy?: string;
}

export interface ImportResult {
  /** The parts of the model's settings to replace. */
  patch: Partial<ModelSettings>;
  report: ImportReport;
}

export class ImportError extends Error {}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown, d: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : d;

// ---------------------------------------------------------------------------
// Known fields. Anything else is listed as unknown and ignored.

const KNOWN_TOP = new Set([
  'Version',
  'Name',
  'ModelID',
  'ModelFolder',
  'ModelSaveMetadata',
  'FileReferences',
  'SavedModelPosition',
  'ModelPositionMovement',
  'ItemSettings',
  'PhysicsSettings',
  'PhysicsCustomizationSettings',
  'GeneralSettings',
  'ParameterSettings',
  'Hotkeys',
  'HotkeySettings',
  'ArtMeshDetails',
  'ParameterCustomization',
  'FolderInfo',
  'UserCustomization',
  'ExpressionGroups',
  'SavedActiveExpressions',
]);
const KNOWN_FILE_REFS = new Set([
  'Model',
  'Icon',
  'IdleAnimation',
  'IdleAnimationWhenTrackingLost',
]);
const KNOWN_PARAM = new Set([
  'Name',
  'Input',
  'InputRangeLower',
  'InputRangeUpper',
  'OutputRangeLower',
  'OutputRangeUpper',
  'ClampInput',
  'ClampOutput',
  'UseBlinking',
  'UseBreathing',
  'OutputLive2D',
  'Smoothing',
  'Folder',
  'Minimized',
]);
const KNOWN_HOTKEY = new Set([
  'HotkeyID',
  'Name',
  'Action',
  'File',
  'Folder',
  'Triggers',
  'IsActive',
  'IsGlobal',
  'Minimized',
  'AutoCreated',
  'StopsOnLastFrame',
  'DeactivateAfterKeyUp',
  'DeactivateAfterSeconds',
  'DeactivateAfterSecondsAmount',
  'FadeSecondsAmount',
  'OnlyLoadOneRandomItem',
  'Position',
  'LoadModelSettings',
  'ColorOverlay',
  'ColorScreenMultiplyPreset',
  'OnScreenHotkeyColor',
  'HandGestureSettings',
  'TwitchTriggers',
  'SoundConfig',
]);
const KNOWN_TRIGGERS = new Set(['Trigger1', 'Trigger2', 'Trigger3', 'ScreenButton']);
const KNOWN_PHYSICS = new Set([
  'Use',
  'UseLegacyPhysics',
  'Live2DPhysicsFPS',
  'PhysicsStrength',
  'WindStrength',
  'DraggingPhysicsStrength',
]);
const KNOWN_GENERAL = new Set([
  'TimeUntilTrackingLostIdleAnimation',
  'WorkshopSharingForbidden',
  'EnableExpressionSaving',
  'ModelVolume',
]);
const KNOWN_HOTKEY_SETTINGS = new Set([
  'UseKeyboardHotkeys',
  'UseOnScreenHotkeys',
  'SendOnScreenHotkeysToPC',
  'OnScreenHotkeyAlpha',
]);
const KNOWN_PINNED = new Set([
  'FileMetadata',
  'SceneName',
  'SceneGroupName',
  'SceneModel',
  'SceneID',
  'Items',
]);

function unknownKeys(o: Obj, known: Set<string>, path: string, out: Set<string>): void {
  for (const k of Object.keys(o)) if (!known.has(k)) out.add(path ? `${path}.${k}` : k);
}

// ---------------------------------------------------------------------------
// Tracking inputs

/**
 * Custom inputs (fed by plugins) have no value in Mochi Studio.
 * Assumed: a custom name that matches a face-tracker blendshape, ignoring
 * case, or with a side letter at the start or end (`LEyeSquint`,
 * `mouthSmileR`), means that blendshape. Others are skipped.
 */
export function guessBlendshape(name: string, blendshapes: readonly string[]): string | undefined {
  const lower = new Map(blendshapes.map((b) => [b.toLowerCase(), b]));
  const n = name.toLowerCase();
  const tries = [n];
  const m1 = /^([lr])([a-z].*)$/.exec(n);
  if (m1) tries.push(`${m1[2]}${m1[1] === 'l' ? 'left' : 'right'}`);
  const m2 = /^(.*[a-z])([lr])$/.exec(n);
  if (m2) tries.push(`${m2[1]}${m2[2] === 'l' ? 'left' : 'right'}`);
  for (const t of tries) {
    const hit = lower.get(t);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * A custom name that matches a pair of blendshapes without saying which
 * one (`nosesNEER`: noseSneerLeft and noseSneerRight; `MouthShrug`:
 * mouthShrugUpper and mouthShrugLower). Assumed: it means their average.
 */
export function guessBlendshapePair(
  name: string,
  blendshapes: readonly string[],
): [string, string] | undefined {
  const lower = new Map(blendshapes.map((b) => [b.toLowerCase(), b]));
  const n = name.toLowerCase();
  for (const [a, b] of [
    ['left', 'right'],
    ['upper', 'lower'],
  ] as const) {
    const x = lower.get(n + a);
    const y = lower.get(n + b);
    if (x && y) return [x, y];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Hotkey keys ("Triggers")

const MODIFIER_KEYS: Record<string, string> = {
  LeftControl: 'Ctrl',
  RightControl: 'Ctrl',
  Control: 'Ctrl',
  LeftShift: 'Shift',
  RightShift: 'Shift',
  Shift: 'Shift',
  Alt: 'Alt',
  LeftAlt: 'Alt',
  RightAlt: 'Alt',
  // The API's key list.
  LeftWindows: 'Meta',
  RightWindows: 'Meta',
};

/**
 * A key name from the file as a keyboard `code`, or as one of Mochi
 * Studio's mouse buttons. The names are the plugin API's key list, which every name in the files seen belongs to, and a few more.
 * Assumed: `N0`–`N9` are the main-row digits and `Left` is the arrow key.
 * The left mouse button counts only with a modifier (Alt+click and the like).
 */
export function keyCode(name: string): string | undefined {
  let m: RegExpExecArray | null;
  if ((m = /^N([0-9])$/.exec(name))) return `Digit${m[1]}`;
  if ((m = /^Numpad([0-9])$/.exec(name))) return `Numpad${m[1]}`;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(name)) return name;
  if (/^[A-Z]$/.test(name)) return `Key${name}`;
  const named: Record<string, string> = {
    Left: 'ArrowLeft',
    Right: 'ArrowRight',
    Up: 'ArrowUp',
    Down: 'ArrowDown',
    Delete: 'Delete',
    Insert: 'Insert',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    Space: 'Space',
    CapsLock: 'CapsLock',
    Print: 'PrintScreen',
    NumLock: 'NumLock',
    ScrollLock: 'ScrollLock',
    Multiply: 'NumpadMultiply',
    Add: 'NumpadAdd',
    Subtract: 'NumpadSubtract',
    Decimal: 'NumpadDecimal',
    Divide: 'NumpadDivide',
    RightMouseButton: 'MouseRight',
    MiddleMouseButton: 'MouseMiddle',
    Return: 'Enter',
    Enter: 'Enter',
    Backspace: 'Backspace',
    Tab: 'Tab',
    Escape: 'Escape',
    Minus: 'Minus',
    Equals: 'Equal',
    Comma: 'Comma',
    Period: 'Period',
    Slash: 'Slash',
    Backslash: 'Backslash',
    Semicolon: 'Semicolon',
    Quote: 'Quote',
    LeftBracket: 'BracketLeft',
    RightBracket: 'BracketRight',
    BackQuote: 'Backquote',
  };
  return named[name];
}

/**
 * The triggers as a Mochi Studio key combination: up to three keys held
 * together. Assumed: the order of the keys does not matter.
 */
export function comboFromTriggers(
  triggers: string[],
): { combo: string } | { combo: ''; problem?: string } {
  const keys = triggers.filter(Boolean);
  if (!keys.length) return { combo: '' };
  const mods: string[] = [];
  const plain: string[] = [];
  for (const k of keys) {
    const mod = MODIFIER_KEYS[k];
    if (mod) mods.push(mod);
    else plain.push(k);
  }
  if (plain.length === 0) return { combo: '', problem: `only modifier keys (${keys.join(' + ')})` };
  const codes: string[] = [];
  for (const k of plain) {
    // The left button counts only with a modifier: a plain click stays a click.
    if (k === 'LeftMouseButton') {
      if (!mods.length)
        return {
          combo: '',
          problem:
            'a plain left click stays for clicking in Mochi Studio (with a modifier it works)',
        };
      codes.push('MouseLeft');
      continue;
    }
    const code = keyCode(k);
    if (!code) return { combo: '', problem: `unknown key name "${k}"` };
    codes.push(code);
  }
  const combo = normalizeCombo([...mods, ...codes].join('+'));
  return combo ? { combo } : { combo: '', problem: `keys ${keys.join(' + ')}` };
}

// ---------------------------------------------------------------------------

/** Finds a bare file name anywhere under the model folder. */
function findFile(
  name: string,
  paths: readonly string[],
  report: ImportReport,
  dupes: Set<string>,
): string | undefined {
  const base = name.toLowerCase();
  const hits = paths
    .filter((p) => (p.split('/').pop() ?? p).toLowerCase() === base)
    // Assumed: with several files of that name, the shallowest one, then the first alphabetically.
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  if (hits.length > 1 && !dupes.has(base)) {
    dupes.add(base);
    report.assumed.push(`Several files are named ${name}; ${hits[0]} is used.`);
  }
  return hits[0];
}

export interface ImportInput {
  /** The text of the `.vtube.json` file. */
  vtubeJson: string;
  /** The text of `items_pinned_to_model.json`, if there is one. */
  pinnedItemsJson?: string;
  manifest: ModelManifest;
  /** Every file path in the model folder (relative to the `.model3.json`). */
  paths: readonly string[];
  /** The model's parameter ids, to report mappings whose parameter is missing. */
  parameters: readonly string[];
  /** The face tracker's blendshape names, for custom inputs. */
  blendshapes: readonly string[];
}

/** Converts a model's VTube Studio settings into Mochi Studio settings. */
export function importVtubeStudio(input: ImportInput): ImportResult {
  let raw: unknown;
  try {
    raw = JSON.parse(input.vtubeJson.replace(/^﻿/, ''));
  } catch {
    throw new ImportError('The settings file is not valid JSON.');
  }
  if (!isObj(raw)) throw new ImportError('The settings file is not a JSON object.');
  if (!Array.isArray(raw.ParameterSettings) && !Array.isArray(raw.Hotkeys))
    throw new ImportError('This does not look like a .vtube.json model settings file.');

  const report: ImportReport = { imported: [], skipped: [], unknownFields: [], assumed: [] };
  const unknown = new Set<string>();
  const assumed = new Set<string>();
  const dupes = new Set<string>();
  const patch: Partial<ModelSettings> = {};

  if (num(raw.Version, 1) !== 1)
    assumed.add(`File version ${String(raw.Version)} is unknown; it is read like version 1.`);
  unknownKeys(raw, KNOWN_TOP, '', unknown);
  if (isObj(raw.ModelSaveMetadata))
    report.savedBy = str(raw.ModelSaveMetadata.LastSavedVTubeStudioVersion) || undefined;

  // --- File references: the idle motion -------------------------------------
  const fr = isObj(raw.FileReferences) ? raw.FileReferences : {};
  unknownKeys(fr, KNOWN_FILE_REFS, 'FileReferences', unknown);
  const idle = str(fr.IdleAnimation);
  if (idle) {
    const file = findFile(idle, input.paths, report, dupes);
    if (file) {
      patch.idleMotion = file;
      report.imported.push(`Idle motion: ${file}`);
    } else report.skipped.push({ what: `Idle motion ${idle}`, reason: 'file not found' });
  }
  if (str(fr.IdleAnimationWhenTrackingLost))
    report.skipped.push({
      what: 'Idle motion while tracking is lost',
      reason: 'its behavior is unknown; Mochi Studio does not have this setting',
    });

  // --- Parameter mappings ----------------------------------------
  const mapping: MappingRule[] = [];
  const params = new Set(input.parameters);
  let breath = false;
  let blink = false;
  if (Array.isArray(raw.ParameterSettings)) {
    raw.ParameterSettings.forEach((p, i) => {
      if (!isObj(p)) return;
      unknownKeys(p, KNOWN_PARAM, 'ParameterSettings[]', unknown);
      const label = str(p.Name) || `#${i + 1}`;
      const output = str(p.OutputLive2D);
      const inName = str(p.Input);
      if (p.UseBreathing === true) {
        breath = true;
        report.imported.push(
          `“${label}”: breathing (${output || 'no parameter'}) → Mochi2D breathing`,
        );
        return;
      }
      if (p.UseBlinking === true) blink = true;
      if (!output) {
        report.skipped.push({ what: `Mapping “${label}”`, reason: 'it names no parameter' });
        return;
      }
      if (!inName) {
        if (p.UseBlinking !== true)
          report.skipped.push({
            what: `Mapping “${label}”`,
            reason: 'it has no input (assumed to do nothing)',
          });
        return;
      }
      let conv = FACE_INPUTS[inName];
      if (!conv) {
        if (UNSUPPORTED_INPUTS[inName]) {
          report.skipped.push({
            what: `Mapping “${label}” (${inName} → ${output})`,
            reason: UNSUPPORTED_INPUTS[inName],
          });
          return;
        }
        const bs = guessBlendshape(inName, input.blendshapes);
        const pair = bs ? undefined : guessBlendshapePair(inName, input.blendshapes);
        if (bs) {
          conv = same(`bs.${bs}`);
          assumed.add(`Custom input ${inName} is read as the face tracker’s ${bs} blendshape.`);
        } else if (pair) {
          conv = same(meanInput(pair.map((p) => `bs.${p}`)));
          assumed.add(
            `Custom input ${inName} is read as the average of the face tracker’s ${pair[0]} and ${pair[1]} blendshapes.`,
          );
        } else {
          report.skipped.push({
            what: `Mapping “${label}” (${inName} → ${output})`,
            reason: 'a custom input from a plugin, which Mochi Studio does not have',
          });
          return;
        }
      }
      if (conv.assumed) assumed.add(conv.assumed);
      // Assumed: a linear map from the input range to the
      // output range; reversed ranges invert.
      const inLo = num(p.InputRangeLower, 0) * conv.scale + conv.offset;
      const inHi = num(p.InputRangeUpper, 1) * conv.scale + conv.offset;
      const smoothing = Math.min(1, Math.max(0, num(p.Smoothing, 0) / 100));
      mapping.push(
        makeRule({
          input: conv.input,
          output,
          inMin: inLo,
          inMax: inHi,
          outMin: num(p.OutputRangeLower, 0),
          outMax: num(p.OutputRangeUpper, 1),
          // Assumed: either clamp flag limits the output to its range.
          clamp: p.ClampInput === true || p.ClampOutput === true,
          smoothing,
        }),
      );
      // A known input without a source: kept, without a value, like a custom
      // input whose plugin is absent.
      const noSource = missingSource(conv.input);
      report.imported.push(
        `“${label}”: ${inName} → ${output}${params.has(output) ? '' : ' (not in this model; kept, has no effect)'}${noSource ? ` (${noSource}; kept, has no value)` : ''}`,
      );
    });
    if (mapping.length) {
      patch.mapping = mapping;
      assumed.add(
        'Mappings: a linear map from the input range to the output range; values outside the input range carry on along the same line unless clamped.',
      );
      assumed.add('Clamping: either clamp flag limits the output to its range (no soft limit).');
      assumed.add(
        'Smoothing: the file’s 0–100 becomes Mochi Studio’s smoothing 0–1 (a time constant of up to 500 ms).',
      );
    }
  }
  if (breath)
    assumed.add(
      'Breathing entries: Mochi2D’s own breathing (on by default, from the model’s breath settings) takes their place.',
    );
  if (blink)
    assumed.add(
      'Auto-blink entries: Mochi Studio blinks automatically while no face is tracked, and follows the tracked eyes otherwise.',
    );

  // --- Hotkeys ----------------------------------------------------
  const hotkeys: Hotkey[] = [];
  const hs = isObj(raw.HotkeySettings) ? raw.HotkeySettings : {};
  unknownKeys(hs, KNOWN_HOTKEY_SETTINGS, 'HotkeySettings', unknown);
  const ignoredOptions = new Set<string>();
  if (Array.isArray(raw.Hotkeys)) {
    raw.Hotkeys.forEach((hk, i) => {
      if (!isObj(hk)) return;
      unknownKeys(hk, KNOWN_HOTKEY, 'Hotkeys[]', unknown);
      const trig = isObj(hk.Triggers) ? hk.Triggers : {};
      unknownKeys(trig, KNOWN_TRIGGERS, 'Hotkeys[].Triggers', unknown);
      const actionName = str(hk.Action);
      const fileName = str(hk.File);
      const name = str(hk.Name) || fileName.replace(/\.(exp3|motion3)\.json$/i, '') || actionName;
      const what = `Hotkey “${name || `#${i + 1}`}” (${actionName || 'no action'})`;
      if (hk.IsActive === false) {
        report.skipped.push({ what, reason: 'it is switched off in the file' });
        return;
      }
      let action: HotkeyAction | undefined;
      switch (actionName) {
        case 'ToggleExpression': {
          const file = fileName ? findFile(fileName, input.paths, report, dupes) : undefined;
          if (!file) {
            report.skipped.push({
              what,
              reason: `expression file ${fileName || '(none)'} not found`,
            });
            return;
          }
          // Mochi Studio refers to listed expressions by name, others by path.
          const entry = input.manifest.expressions.find((e) => e.file === file);
          action = { type: 'expression', expression: entry?.name ?? file };
          break;
        }
        case 'TriggerAnimation': {
          const file = fileName ? findFile(fileName, input.paths, report, dupes) : undefined;
          const entry = file ? input.manifest.motions.find((m) => m.file === file) : undefined;
          if (!entry) {
            report.skipped.push({
              what,
              reason: file
                ? `${file} is not one of the model’s motions`
                : `motion file ${fileName || '(none)'} not found`,
            });
            return;
          }
          action = {
            type: 'motion',
            motion: { group: entry.group, index: entry.index },
            mode: hk.StopsOnLastFrame === true ? 'hold' : 'once',
          };
          break;
        }
        case 'RemoveAllExpressions':
          action = { type: 'clearExpressions' };
          break;
        case 'CalibrateCam':
          action = { type: 'calibrate' };
          break;
        case 'ScreenColorOverlay': {
          // The light overlay's recorded settings: kept, the file's object too.
          const co = isObj(hk.ColorOverlay) ? hk.ColorOverlay : {};
          const overlay = overlayFromFile(co);
          action = { type: 'screenOverlay', overlay };
          if (overlay.on && overlay.source === 'capture')
            report.assumed.push(
              `Hotkey “${name}”: a Screen Overlay capture applies its settings; the capture itself starts in the Camera tab (a browser asks which screen)${overlay.windowName ? `, and the window “${overlay.windowName}” is not looked for` : ''}.`,
            );
          break;
        }
        case 'Unset':
        case '':
          report.skipped.push({ what, reason: 'it has no action' });
          return;
        case 'ToggleItemScene':
          // The file's item scenes are in a format not known.
          report.skipped.push({
            what,
            reason:
              'its item scene cannot be read; make the scene in the Items sheet, then its hotkey',
          });
          return;
        default:
          report.skipped.push({ what, reason: 'Mochi Studio has no such hotkey action' });
          return;
      }
      const keys = comboFromTriggers([str(trig.Trigger1), str(trig.Trigger2), str(trig.Trigger3)]);
      if ('problem' in keys && keys.problem)
        report.skipped.push({
          what: `${what}: its keys`,
          reason: `${keys.problem}; imported as a button only`,
        });
      const screenButton = num(trig.ScreenButton, -1);
      // The hand-gesture settings: kept verbatim and written back
      // unchanged, but never fired, since the file's gesture names are not known.
      const importedGesture = keepImportedGesture(hk.HandGestureSettings);
      const named = importedGestureNames(importedGesture);
      if (named.length)
        report.skipped.push({
          what: `${what}: its hand gesture (${named.join(', ')})`,
          reason:
            'kept with the hotkey as it is, but not used: the gesture names in the file are not known yet; set a gesture up in the Hotkeys tab',
        });
      // Turn-off options, for expression hotkeys (and items, which the file does not use).
      const toggles = action.type === 'expression';
      let release: Hotkey['release'];
      let seconds: number | undefined;
      if (hk.DeactivateAfterKeyUp === true) {
        if (toggles) release = 'hold';
        else ignoredOptions.add('turn off when the key is released (only for expressions)');
      } else if (hk.DeactivateAfterSeconds === true) {
        if (toggles) {
          release = 'timer';
          seconds = Math.max(0.1, num(hk.DeactivateAfterSecondsAmount, 5));
        } else ignoredOptions.add('turn off after some seconds (only for expressions)');
      }
      if (hk.DeactivateAfterKeyUp === true && hk.DeactivateAfterSeconds === true && toggles)
        ignoredOptions.add(
          'turn off after some seconds, together with “while held” (kept: while held)',
        );
      hotkeys.push({
        id: `vts-${i}`,
        label: str(hk.Name),
        keys: keys.combo,
        // Assumed: an on-screen button number (1–8) means a button; a hotkey
        // without keys gets one too, so it stays usable.
        button: screenButton > 0 || !keys.combo,
        ...(importedGesture ? { importedGesture } : {}),
        action,
        ...(release ? { release } : {}),
        ...(seconds !== undefined ? { seconds } : {}),
      });
      report.imported.push(
        `${what}${keys.combo ? ` on ${keys.combo}` : ''}${action.type === 'motion' && action.mode === 'hold' ? ', holds the last frame' : ''}${release === 'hold' ? ', on while held' : ''}${release === 'timer' ? `, off after ${seconds} s` : ''}`,
      );
    });
  }
  if (hotkeys.length) patch.hotkeys = hotkeys;
  for (const o of ignoredOptions)
    report.skipped.push({
      what: `Hotkey option “${o}”`,
      reason: 'Mochi Studio does not have it yet',
    });
  if (Array.isArray(raw.Hotkeys) && raw.Hotkeys.length)
    report.skipped.push({
      what: 'Hotkey fade times',
      reason: 'Mochi2D uses the expression and motion files’ own fades',
    });
  if (hs.UseKeyboardHotkeys === false)
    report.skipped.push({
      what: 'Keyboard hotkeys switched off',
      reason: 'Mochi Studio has no such switch; the keys were imported',
    });

  // --- Physics, placement and the rest ---------------------------------------
  const ph = isObj(raw.PhysicsSettings) ? raw.PhysicsSettings : undefined;
  if (ph) {
    unknownKeys(ph, KNOWN_PHYSICS, 'PhysicsSettings', unknown);
    if (typeof ph.Use === 'boolean') {
      patch.physics = ph.Use;
      report.imported.push(`Physics ${ph.Use ? 'on' : 'off'}`);
    }
    // The same 0–100 scales as Mochi Studio's (src/core/physicsTuning.ts).
    const strength = num(ph.PhysicsStrength, 50);
    const wind = num(ph.WindStrength, 0);
    if (strength !== 50 || wind !== 0) {
      patch.physicsTuning = parsePhysicsTuning({ strength, wind, groups: {} });
      report.imported.push(
        `Physics strength ${patch.physicsTuning.strength} and wind ${patch.physicsTuning.wind}`,
      );
    }
  }
  const pc = isObj(raw.PhysicsCustomizationSettings) ? raw.PhysicsCustomizationSettings : {};
  if (Object.values(pc).some((v) => Array.isArray(v) && v.length > 0))
    report.skipped.push({
      what: 'Physics group multipliers',
      reason: 'their format is unknown; set them in the Model tab',
    });
  if (isObj(raw.GeneralSettings))
    unknownKeys(raw.GeneralSettings, KNOWN_GENERAL, 'GeneralSettings', unknown);
  if (isObj(raw.SavedModelPosition))
    report.skipped.push({
      what: 'Saved model position',
      reason:
        'its units are unknown, so it would not be meaningful; place the model in the Output tab',
    });
  if (isObj(raw.ModelPositionMovement) && raw.ModelPositionMovement.Use === true)
    report.skipped.push({
      what: 'Moving the model with the head',
      reason: 'Mochi Studio does not have it yet (and the axes and scale are unknown)',
    });
  if (isObj(raw.ItemSettings))
    report.imported.push(
      'Item settings: Mochi2D reads them itself when this model is added as an item',
    );
  const art = isObj(raw.ArtMeshDetails) ? raw.ArtMeshDetails : {};
  const nonEmpty = (v: unknown): boolean => Array.isArray(v) && v.length > 0;
  // How much the light overlay affects each art mesh: {ID, Value} pairs.
  const lighting = art.ArtMeshSceneLightingMultipliers;
  if (Array.isArray(lighting)) {
    const strengths: Record<string, number> = {};
    for (const e of lighting)
      if (isObj(e) && typeof e.ID === 'string' && typeof e.Value === 'number')
        strengths[e.ID] = e.Value;
    patch.lightStrengths = parseLightStrengths(strengths);
    if (lighting.length)
      report.imported.push(
        `Light strength for ${lighting.length} art mesh(es) (Model tab, light from the screen)`,
      );
  }
  const { ArtMeshSceneLightingMultipliers: _l, ...otherArt } = art;
  if (Object.values(otherArt).some(nonEmpty))
    report.skipped.push({
      what: 'Art mesh settings (colors, lighting, pinning rules)',
      reason: 'their format is unknown',
    });
  if (nonEmpty(raw.ExpressionGroups))
    report.skipped.push({ what: 'Expression groups', reason: 'their format is unknown' });

  // --- items_pinned_to_model.json ---------------------------------
  if (input.pinnedItemsJson !== undefined) {
    let pinned: unknown;
    try {
      pinned = JSON.parse(input.pinnedItemsJson.replace(/^﻿/, ''));
    } catch {
      pinned = undefined;
    }
    if (!isObj(pinned)) {
      report.skipped.push({ what: 'items_pinned_to_model.json', reason: 'not a JSON object' });
    } else {
      unknownKeys(pinned, KNOWN_PINNED, 'items_pinned_to_model', unknown);
      const items = Array.isArray(pinned.Items) ? pinned.Items : [];
      if (items.length)
        report.skipped.push({
          what: `${items.length} pinned item(s)`,
          reason: 'the entry format is unknown; add the items in the Items tab',
        });
      else report.imported.push('Pinned items: none in the file');
    }
  }

  report.unknownFields = [...unknown].sort();
  report.assumed = [...report.assumed, ...assumed];
  return { patch, report };
}

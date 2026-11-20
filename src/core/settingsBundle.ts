import { zipSync } from 'fflate';
import { sourceFromZip } from 'mochi2d/headless';
import { newItemId } from './items';
import { SettingsError, importSettings, type ModelSettings } from './settings';

/**
 * A settings export with item files: a zip holding the settings JSON
 * (`SETTINGS_ENTRY`) and each item's folder under `items/<item id>/`.
 * Item files are model data with their own terms of use, so this is an
 * option, off by default.
 */
export const SETTINGS_ENTRY = 'mochi-settings.json';

export function buildSettingsBundle(
  settingsJson: string,
  items: Array<{ id: string; files: Array<[string, Uint8Array]> }>,
): Uint8Array {
  const entries: Record<string, Uint8Array> = {
    [SETTINGS_ENTRY]: new TextEncoder().encode(settingsJson),
  };
  for (const item of items)
    for (const [path, data] of item.files) entries[`items/${item.id}/${path}`] = data;
  return zipSync(entries, { level: 6 });
}

export interface ImportedBundle {
  settings: ModelSettings;
  /** Item files by the (new) item id used in `settings`. */
  itemFiles: Map<string, Array<[string, Uint8Array]>>;
}

export const isZip = (d: Uint8Array): boolean => d[0] === 0x50 && d[1] === 0x4b;

/**
 * Reads an exported settings file: plain JSON, or a zip with item files.
 * Items get new ids, so importing the same file into two models keeps their
 * item files apart; hotkeys and the item layout follow.
 */
export async function readSettingsExport(
  data: Uint8Array,
  modelKey: string,
  takenIds: Iterable<string> = [],
): Promise<ImportedBundle> {
  if (!isZip(data))
    return {
      settings: importSettings(new TextDecoder().decode(data), modelKey),
      itemFiles: new Map(),
    };
  let zip: ReturnType<typeof sourceFromZip>;
  try {
    zip = sourceFromZip('settings', data);
  } catch {
    throw new SettingsError('The file is not a readable zip.');
  }
  const paths = zip.list() ?? [];
  if (!paths.includes(SETTINGS_ENTRY))
    throw new SettingsError(
      `The zip has no ${SETTINGS_ENTRY}: not a Mochi Studio settings export.`,
    );
  const settings = importSettings(
    new TextDecoder().decode(await zip.read(SETTINGS_ENTRY)),
    modelKey,
  );

  const taken = new Set(takenIds);
  const rename = new Map<string, string>();
  for (const item of settings.items) {
    const id = newItemId(taken);
    taken.add(id);
    rename.set(item.id, id);
  }
  const itemFiles = new Map<string, Array<[string, Uint8Array]>>();
  for (const p of paths) {
    const m = /^items\/([^/]+)\/(.+)$/.exec(p);
    if (!m || p.endsWith('/')) continue;
    const id = rename.get(m[1]!);
    if (!id) continue;
    const list = itemFiles.get(id) ?? [];
    list.push([m[2]!, await zip.read(p)]);
    itemFiles.set(id, list);
  }
  const newId = (id: string) => rename.get(id) ?? id;
  settings.items = settings.items.map((i) => ({ ...i, id: newId(i.id) }));
  settings.hotkeys = settings.hotkeys.map((h) =>
    h.action.type === 'item' ? { ...h, action: { ...h.action, item: newId(h.action.item) } } : h,
  );
  settings.itemScenes = settings.itemScenes.map((sc) => ({
    ...sc,
    items: sc.items.map((i) => ({ ...i, id: newId(i.id) })),
  }));
  const layout = settings.itemLayout as { mochiStudioIds?: unknown } | undefined;
  if (layout && Array.isArray(layout.mochiStudioIds))
    layout.mochiStudioIds = layout.mochiStudioIds.map((x) =>
      typeof x === 'string' ? newId(x) : x,
    );
  return { settings, itemFiles };
}

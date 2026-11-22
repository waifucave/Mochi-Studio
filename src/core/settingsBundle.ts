import { zipSync } from 'fflate';
import { sourceFromZip } from 'mochi2d/headless';
import {
  fileTooLargeMessage,
  formatBytes,
  maxArchiveFileBytes,
  MAX_SETTINGS_JSON_BYTES,
  SETTINGS_ARCHIVE_LIMITS,
} from './archiveLimits';
import { newItemId } from './items';
import { describeArchiveError } from './modelFiles';
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
  // Never write a file that the import would refuse.
  const caps = SETTINGS_ARCHIVE_LIMITS;
  const sizes = Object.values(entries).map((d) => d.length);
  const total = sizes.reduce((a, b) => a + b, 0);
  const largest = Math.max(...sizes);
  if (sizes.length > caps.maxEntries || total > caps.maxTotalBytes || largest > caps.maxEntryBytes)
    throw new SettingsError(
      `The items are too large to export with the settings (${formatBytes(total)} in ${sizes.length} files; the most is ${formatBytes(caps.maxTotalBytes)} in ${caps.maxEntries} files, ${formatBytes(caps.maxEntryBytes)} a file). Export without the item files.`,
    );
  const zip = zipSync(entries, { level: 6 });
  if (zip.length > maxArchiveFileBytes(caps))
    throw new SettingsError(
      `The settings file would be too large to import again (${formatBytes(zip.length)}). Export without the item files.`,
    );
  return zip;
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
  const what = 'This settings file';
  if (!isZip(data)) {
    if (data.length > MAX_SETTINGS_JSON_BYTES)
      throw new SettingsError(fileTooLargeMessage(what, data.length, MAX_SETTINGS_JSON_BYTES));
    return {
      settings: importSettings(new TextDecoder().decode(data), modelKey),
      itemFiles: new Map(),
    };
  }
  const caps = SETTINGS_ARCHIVE_LIMITS;
  if (data.length > maxArchiveFileBytes(caps))
    throw new SettingsError(fileTooLargeMessage(what, data.length, maxArchiveFileBytes(caps)));
  const refuse = (e: unknown): SettingsError =>
    e instanceof SettingsError
      ? e
      : new SettingsError(
          describeArchiveError(e, what)?.message ?? 'The file is not a readable zip.',
        );
  let zip: ReturnType<typeof sourceFromZip>;
  try {
    zip = sourceFromZip('settings', data, caps);
  } catch (e) {
    throw refuse(e);
  }
  const read = async (p: string): Promise<Uint8Array> => {
    try {
      return await zip.read(p);
    } catch (e) {
      throw refuse(e);
    }
  };
  const paths = zip.list() ?? [];
  if (!paths.includes(SETTINGS_ENTRY))
    throw new SettingsError(
      `The zip has no ${SETTINGS_ENTRY}: not a Mochi Studio settings export.`,
    );
  const json = await read(SETTINGS_ENTRY);
  if (json.length > MAX_SETTINGS_JSON_BYTES)
    throw new SettingsError(
      `${what} is larger than we accept. Its settings are ${formatBytes(json.length)}; the most is ${formatBytes(MAX_SETTINGS_JSON_BYTES)}.`,
    );
  const settings = importSettings(new TextDecoder().decode(json), modelKey);

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
    list.push([m[2]!, await read(p)]);
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

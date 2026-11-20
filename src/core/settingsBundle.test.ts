import { describe, expect, it } from 'vitest';
import { defaultSettings, exportSettings, SettingsError } from './settings';
import { buildSettingsBundle, readSettingsExport } from './settingsBundle';

describe('settings export with item files', () => {
  const s = {
    ...defaultSettings('a.model3.json#1', []),
    items: [{ id: 'item-old', label: 'Hat', visible: true, pinned: true }],
    hotkeys: [
      {
        id: 'h',
        label: '',
        keys: 'KeyH',
        button: true,
        action: { type: 'item' as const, item: 'item-old' },
      },
    ],
    itemLayout: { format: 'mochi2d-item-layout/1', items: [], mochiStudioIds: ['item-old'] },
  };
  const files: Array<[string, Uint8Array]> = [
    ['hat.model3.json', new TextEncoder().encode('{}')],
    ['tex/hat.png', new Uint8Array([1, 2, 3])],
  ];

  it('round-trips the settings and item files, with new item ids', async () => {
    const zip = buildSettingsBundle(exportSettings(s), [{ id: 'item-old', files }]);
    const out = await readSettingsExport(zip, 'b.model3.json#2', ['item-taken']);
    expect(out.settings.modelKey).toBe('b.model3.json#2');
    const id = out.settings.items[0]!.id;
    expect(id).not.toBe('item-old');
    expect(out.settings.hotkeys[0]!.action).toEqual({ type: 'item', item: id });
    expect((out.settings.itemLayout as { mochiStudioIds: string[] }).mochiStudioIds).toEqual([id]);
    expect(out.itemFiles.get(id)).toEqual(files);
  });

  it('still reads plain JSON, and rejects other zips', async () => {
    const json = new TextEncoder().encode(exportSettings(s));
    const out = await readSettingsExport(json, 'k');
    expect(out.settings.items[0]!.id).toBe('item-old');
    expect(out.itemFiles.size).toBe(0);
    const other = buildSettingsBundle('{}', []).slice();
    // A zip without the settings entry.
    const { zipSync } = await import('fflate');
    await expect(
      readSettingsExport(zipSync({ 'x.txt': new Uint8Array([1]) }), 'k'),
    ).rejects.toThrow(SettingsError);
    await expect(readSettingsExport(other, 'k')).rejects.toThrow(SettingsError);
  });
});

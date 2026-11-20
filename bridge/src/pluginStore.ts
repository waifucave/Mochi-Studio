/**
 * Plugins the person has allowed (the plugin API, src/core/plugins/): one
 * record per plugin name and developer, with its token (only a hash is
 * kept), whether it may read tracking data, and its custom parameters.
 * Kept in `plugins.json` in the bridge's folder, readable by the user only.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CustomParameter, PluginInfo } from '../../src/core/plugins/protocol.ts';

export interface StoredParameter {
  name: string;
  explanation: string;
  min: number;
  max: number;
  defaultValue: number;
}

interface PluginRecord {
  id: string;
  name: string;
  developer: string;
  icon: string;
  hash: string;
  trackingData: boolean;
  /** Permissions the person granted; absent in older files. */
  permissions?: string[];
  created: number;
  lastUsed: number | null;
  parameters: StoredParameter[];
}

const hash = (token: string): string => createHash('sha256').update(token).digest('hex');

export class PluginStore {
  private file: string;
  private records: PluginRecord[];

  constructor(dir: string) {
    this.file = join(dir, 'plugins.json');
    this.records = this.load();
  }

  private load(): PluginRecord[] {
    if (!existsSync(this.file)) return [];
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { plugins?: unknown };
      return Array.isArray(raw.plugins)
        ? (raw.plugins as PluginRecord[]).filter(
            (r) => r && typeof r.id === 'string' && typeof r.hash === 'string',
          )
        : [];
    } catch {
      return [];
    }
  }

  private save(): void {
    writeFileSync(this.file, JSON.stringify({ version: 1, plugins: this.records }, null, 2), {
      mode: 0o600,
    });
  }

  find(name: string, developer: string): PluginRecord | undefined {
    return this.records.find((r) => r.name === name && r.developer === developer);
  }
  get(id: string): PluginRecord | undefined {
    return this.records.find((r) => r.id === id);
  }

  /** Allows a plugin (again): a new token; an existing record keeps its grants and parameters. */
  allow(name: string, developer: string, icon: string): { token: string; record: PluginRecord } {
    const token = randomBytes(24).toString('base64url');
    let record = this.find(name, developer);
    if (record) {
      record.hash = hash(token);
      record.icon = icon || record.icon;
    } else {
      record = {
        id: randomBytes(6).toString('hex'),
        name,
        developer,
        icon,
        hash: hash(token),
        trackingData: false,
        created: Date.now(),
        lastUsed: null,
        parameters: [],
      };
      this.records.push(record);
    }
    this.save();
    return { token, record };
  }

  /** The plugin a token belongs to, if the name and developer match it. */
  verify(name: string, developer: string, token: string): PluginRecord | undefined {
    const r = this.find(name, developer);
    if (!r) return undefined;
    const a = Buffer.from(hash(token));
    const b = Buffer.from(r.hash);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
    r.lastUsed = Date.now();
    this.save();
    return r;
  }

  /** Revokes a plugin: its token, grants and custom parameters go. */
  revoke(id: string): boolean {
    const n = this.records.length;
    this.records = this.records.filter((r) => r.id !== id);
    if (this.records.length === n) return false;
    this.save();
    return true;
  }

  hasPermission(id: string, permission: string): boolean {
    return this.get(id)?.permissions?.includes(permission) ?? false;
  }

  setPermission(id: string, permission: string, granted: boolean): void {
    const r = this.get(id);
    if (!r) return;
    const rest = (r.permissions ?? []).filter((p) => p !== permission);
    r.permissions = granted ? [...rest, permission] : rest;
    this.save();
  }

  setTrackingData(id: string, on: boolean): void {
    const r = this.get(id);
    if (!r) return;
    r.trackingData = on;
    this.save();
  }

  /** Every custom parameter, with its plugin. */
  parameters(): CustomParameter[] {
    return this.records.flatMap((r) =>
      r.parameters.map((p) => ({ ...p, pluginId: r.id, pluginName: r.name })),
    );
  }

  setParameter(id: string, p: StoredParameter): void {
    const r = this.get(id);
    if (!r) return;
    r.parameters = [...r.parameters.filter((x) => x.name !== p.name), p];
    this.save();
  }

  deleteParameter(id: string, name: string): void {
    const r = this.get(id);
    if (!r) return;
    r.parameters = r.parameters.filter((x) => x.name !== name);
    this.save();
  }

  list(sessions: (id: string) => number): PluginInfo[] {
    return this.records.map((r) => ({
      id: r.id,
      name: r.name,
      developer: r.developer,
      icon: r.icon,
      trackingData: r.trackingData,
      permissions: r.permissions ?? [],
      sessions: sessions(r.id),
      created: r.created,
      lastUsed: r.lastUsed,
    }));
  }
}

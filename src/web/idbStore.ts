import {
  parseAppSettings,
  parseSettings,
  type AppSettings,
  type ModelSettings,
  type SettingsStore,
} from '../core/settings';

const DB = 'mochi-studio';
const SETTINGS = 'model-settings';
const APP = 'app-settings';
const ITEM_FILES = 'item-files';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const open = factory.open(DB, 2);
    open.onupgradeneeded = () => {
      const db = open.result;
      for (const name of [SETTINGS, APP, ITEM_FILES])
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
    };
    open.onsuccess = () => res(open.result);
    open.onerror = () => rej(open.error);
  });
}

let shared: Promise<IDBDatabase> | undefined;
const database = (factory: IDBFactory): Promise<IDBDatabase> =>
  factory === indexedDB ? (shared ??= openDb(factory)) : openDb(factory);

async function store(
  db: Promise<IDBDatabase>,
  name: string,
  mode: IDBTransactionMode,
): Promise<IDBObjectStore> {
  return (await db).transaction(name, mode).objectStore(name);
}

/** Per-model and app-wide settings in IndexedDB. Values are re-validated on read. */
export class IdbSettingsStore implements SettingsStore {
  private db: Promise<IDBDatabase>;

  constructor(factory: IDBFactory = indexedDB) {
    this.db = database(factory);
  }

  async get(key: string): Promise<ModelSettings | undefined> {
    const v: unknown = await req((await store(this.db, SETTINGS, 'readonly')).get(key));
    if (v === undefined) return undefined;
    try {
      return parseSettings(v, key);
    } catch {
      return undefined;
    }
  }
  async put(s: ModelSettings): Promise<void> {
    await req(
      (await store(this.db, SETTINGS, 'readwrite')).put(JSON.parse(JSON.stringify(s)), s.modelKey),
    );
  }
  async delete(key: string): Promise<void> {
    await req((await store(this.db, SETTINGS, 'readwrite')).delete(key));
  }
  async keys(): Promise<string[]> {
    return (await req((await store(this.db, SETTINGS, 'readonly')).getAllKeys())).map(String);
  }
  async getApp(): Promise<AppSettings> {
    return parseAppSettings(await req((await store(this.db, APP, 'readonly')).get('app')));
  }
  async putApp(s: AppSettings): Promise<void> {
    await req((await store(this.db, APP, 'readwrite')).put(JSON.parse(JSON.stringify(s)), 'app'));
  }
}

/** Item files (model data), kept only in this browser. */
export interface ItemFileStore {
  get(id: string): Promise<Array<[string, Uint8Array]> | undefined>;
  put(id: string, files: Array<[string, Uint8Array]>): Promise<void>;
  delete(id: string): Promise<void>;
}

export class IdbItemFileStore implements ItemFileStore {
  private db: Promise<IDBDatabase>;

  constructor(factory: IDBFactory = indexedDB) {
    this.db = database(factory);
  }

  async get(id: string): Promise<Array<[string, Uint8Array]> | undefined> {
    const v: unknown = await req((await store(this.db, ITEM_FILES, 'readonly')).get(id));
    if (!Array.isArray(v)) return undefined;
    return v.filter(
      (e): e is [string, Uint8Array] =>
        Array.isArray(e) && typeof e[0] === 'string' && e[1] instanceof Uint8Array,
    );
  }
  async put(id: string, files: Array<[string, Uint8Array]>): Promise<void> {
    await req((await store(this.db, ITEM_FILES, 'readwrite')).put(files, id));
  }
  async delete(id: string): Promise<void> {
    await req((await store(this.db, ITEM_FILES, 'readwrite')).delete(id));
  }
}

/** For tests and non-browser hosts. */
export class MemoryItemFileStore implements ItemFileStore {
  private map = new Map<string, Array<[string, Uint8Array]>>();
  async get(id: string): Promise<Array<[string, Uint8Array]> | undefined> {
    return this.map.get(id);
  }
  async put(id: string, files: Array<[string, Uint8Array]>): Promise<void> {
    this.map.set(id, files);
  }
  async delete(id: string): Promise<void> {
    this.map.delete(id);
  }
}

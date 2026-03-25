import { AuthDetails, KnowmeldSettings, KnowmeldSettingStore } from "./settings.store";
import { CacheData, CacheEntry, PersistedCache } from "./types";

export class CacheStore implements PersistedCache {
  private data: CacheData;
  private saveCallback: () => Promise<void>;

  constructor(data: CacheData, saveCallback: () => Promise<void>) {
    this.data = data;
    this.saveCallback = saveCallback;
  }

  /**
   * Migrates the raw persisted cache (which may contain legacy string-hash values)
   * into the current { hash, documentId } CacheEntry format.
   */
  static fromRaw(raw: Record<string, unknown>): CacheData {
    const migrated: CacheData = {};
    for (const [path, value] of Object.entries(raw)) {
      if (typeof value === "string") {
        migrated[path] = { hash: value };
      } else {
        migrated[path] = value as CacheEntry;
      }
    }
    return migrated;
  }

  get(path: string): string | undefined {
    return this.data[path]?.hash;
  }

  set(path: string, hash: string): void {
    const existing = this.data[path];
    this.data[path] = { ...existing, hash };
  }

  remove(path: string): void {
    delete this.data[path];
  }

  rename(oldPath: string, newPath: string): void {
    if (this.data[oldPath]) {
      this.data[newPath] = this.data[oldPath];
      delete this.data[oldPath];
    }
  }

  getDocumentId(path: string): string | undefined {
    return this.data[path]?.documentId;
  }

  setDocumentId(path: string, documentId: string): void {
    if (this.data[path]) {
      this.data[path].documentId = documentId;
    }
  }

  async save(): Promise<void> {
    await this.saveCallback();
  }

  getData(): CacheData {
    return this.data;
  }

  async clear(): Promise<void> {
    this.data = {};
    await this.saveCallback();
  }
}

export class SettingsStore implements KnowmeldSettingStore {
  private settings: KnowmeldSettings;

  constructor(settings: KnowmeldSettings) {
    this.settings = settings;
  }

  get(): KnowmeldSettings {
    return this.settings;
  }

  set(update: Record<string, string | boolean | number | string[] | AuthDetails | null>): void {
    this.settings = { ...this.settings, ...update } as KnowmeldSettings;
  }
}

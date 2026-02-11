import { Notice, Plugin, TAbstractFile, TFile } from "obsidian";

import { FileSyncer } from "./syncer";
import { KnowmeldSettingTab } from "./settings";
import { DEFAULT_SETTINGS, KnowmeldSettings } from "./settings.store";
import { Authenticator } from "./authenticator";

interface CacheEntry {
  hash: string;
  documentId?: string;
}

interface CacheData {
  [path: string]: CacheEntry;
}

type PersistedData = {
  cache: CacheData;
  log?: string;
  settings: KnowmeldSettings;
}

interface PersistedCache {
  get(path: string): string | undefined;
  set(path: string, hash: string): void;
  remove(path: string): void;
  rename(oldPath: string, newPath: string): void;
  getDocumentId(path: string): string | undefined;
  setDocumentId(path: string, documentId: string): void;
  save(): Promise<void>;
}

export default class KnowmeldPlugin extends Plugin {
  private syncer!: FileSyncer;
  private settingTab!: KnowmeldSettingTab;
  private pendingFiles: Set<string> = new Set();
  private syncTimeout: ReturnType<typeof setTimeout> | null = null;
  private authenticator!: Authenticator;
  private syncing: boolean = false;

  private data: PersistedData = {
    cache: {},
    settings: DEFAULT_SETTINGS,
  };

  async onload(): Promise<void> {
    const loadedData = await this.loadData();
    // Migrate old cache format (string hash) to new format ({ hash, documentId })
    const rawCache = loadedData?.cache || {};
    const migratedCache: CacheData = {};
    for (const [path, value] of Object.entries(rawCache)) {
      if (typeof value === 'string') {
        migratedCache[path] = { hash: value };
      } else {
        migratedCache[path] = value as CacheEntry;
      }
    }
    this.data = {
      cache: migratedCache,
      settings: { ...DEFAULT_SETTINGS, ...loadedData?.settings },
    }
    const cacheStore: PersistedCache = {
      get: (path: string) => this.data.cache[path]?.hash,
      set: (path: string, hash: string) => {
        const existing = this.data.cache[path];
        this.data.cache[path] = { ...existing, hash };
      },
      remove: (path: string) => {
        delete this.data.cache[path];
      },
      rename: (oldPath: string, newPath: string) => {
        if (this.data.cache[oldPath]) {
          this.data.cache[newPath] = this.data.cache[oldPath];
          delete this.data.cache[oldPath];
        }
      },
      getDocumentId: (path: string) => this.data.cache[path]?.documentId,
      setDocumentId: (path: string, documentId: string) => {
        if (this.data.cache[path]) {
          this.data.cache[path].documentId = documentId;
        }
      },
      save: async () => {
        await this.persistData();
      }
    }
    const settingsStore = {
      get: (): KnowmeldSettings => this.data.settings,
      set: (setting: Record<string, string | boolean | number | string[]>): void => {
        this.data.settings = { ...this.data.settings, ...setting };
      }
    };
    this.authenticator = new Authenticator(settingsStore, cacheStore);
    this.settingTab = new KnowmeldSettingTab(this.app, this, settingsStore, this.authenticator);
    this.syncer = new FileSyncer(this.app, this.app.vault, cacheStore, settingsStore, this.authenticator);
    this.addSettingTab(this.settingTab);
    this.registerObsidianProtocolHandler("knowmeld-auth", async (params) => {
      const { pairingCode, correlationId } = params;
      if (!pairingCode || !correlationId) {
        new Notice("Knowmeld: Could not get connection parameters. Please try again.");
        return;
      }
      this.authenticator.finishPairing(pairingCode, correlationId).then(async (success) => {
        if (success) {
          new Notice("Knowmeld: Device successfully connected!");
          this.settingTab.display();
        } else {
          new Notice("Knowmeld: Failed to connect device. Could not retrieve code from server. Please try again.");
        }
      });
    });

    this.addRibbonIcon("refresh-cw", "Sync all to Knowmeld", async () => {
      await this.syncer.syncAll();
    });

    this.addCommand({
      id: "sync-all",
      name: "Sync all files to Knowmeld",
      checkCallback: (checking: boolean) => {
        const connected = this.authenticator.isConnected();

        if (checking) return connected;

        if (!connected) {
          new Notice("Knowmeld: Your device has not been connected. Please connect in the settings.");
          return false;
        }

        this.syncer.syncAll();
        return true;
      },
    });

    this.addCommand({
      id: "sync-current",
      name: "Sync current file to Knowmeld",
      checkCallback: (checking: boolean) => {
        const connected = this.authenticator.isConnected();
        const file = this.app.workspace.getActiveFile();
        const ok = !!(connected && file && file.path.endsWith(".md"));

        if (checking) return ok;

        if (!connected) {
          new Notice("Knowmeld: Your device has not been connected. Please connect in the settings.");
          return false;
        }
        if (file && file.path.endsWith(".md")) {
          this.syncer.syncFile(file);
          return true;
        }
        return false;
      },
    });


    let ready = false;
    this.app.workspace.onLayoutReady(() => {
      if (ready) return;
      ready = true;
    });

    // Real-time sync: queue files on modify/create
    this.registerEvent(
      this.app.vault.on("modify", (file: TAbstractFile) => {
        if (!ready) return;
        if (file instanceof TFile && file.path.endsWith(".md")) {
          this.queueFileForSync(file.path);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("create", (file: TAbstractFile) => {
        if (!ready) return;
        if (file instanceof TFile && file.path.endsWith(".md")) {
          console.log(`Knowmeld: Queuing created file ${file.path}`);
          this.queueFileForSync(file.path);
        }
      })
    );

    // Track deleted files for batch notification
    this.registerEvent(
      this.app.vault.on("delete", (file: TAbstractFile) => {
        if (!ready) return;
        if (file.path.endsWith(".md")) {
          console.log(`Knowmeld: Queuing deleted file ${file.path}`);
          const documentId = this.data.cache[file.path]?.documentId;
          if (documentId) {
            this.data.settings.deletedDocumentIds.push(documentId);
          }
          this.syncer.handleDelete(file.path);
          this.persistData();
        }
      })
    );

    // Handle renames: remove old path from cache, queue new path for sync
    this.registerEvent(
      this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
        if (!ready) return;
        if (file.path.endsWith(".md")) {
          console.log(`Knowmeld: Handling renamed file ${oldPath} -> ${file.path}`);
          this.syncer.handleRename(oldPath, file.path);
          this.queueFileForSync(file.path);
        }
      })
    );

    // Flush deleted files every 10 minutes
    this.registerInterval(
      window.setInterval(() => this.flushDeletedFiles(), 5 * 60 * 1000)
    );
  }


  private queueFileForSync(path: string): void {
    if (!this.authenticator.isConnected()) return;
    this.pendingFiles.add(path);

    // Clear existing timeout
    if (this.syncTimeout) {
      clearTimeout(this.syncTimeout);
    }

    // Set new timeout based on configured interval
    const intervalMs = this.data.settings.realtimeSyncInterval * 1000;
    this.syncTimeout = setTimeout(() => {
      this.syncPendingFiles();
    }, intervalMs);
  }

  private async syncPendingFiles(): Promise<void> {
    if (this.syncing) return;
    if (this.pendingFiles.size === 0) return;
    this.syncing = true;
    try {
      if (!await this.authenticator.ensureAuthenticated()) return;

      const filesToSync = Array.from(this.pendingFiles);
      this.pendingFiles.clear();
      this.syncTimeout = null;
      console.log(`Knowmeld: Syncing ${filesToSync.length} pending files...`);

      // Get TFile objects for pending paths
      const files: TFile[] = [];
      for (const path of filesToSync) {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
          files.push(file);
        }
      }

      if (files.length === 0) return;

      // Sync pending files
      await this.syncer.syncFiles(files);

    } finally {
      this.syncing = false;
    }
  }

  private async flushDeletedFiles(): Promise<void> {
    const deletedDocumentIds = this.data.settings.deletedDocumentIds;
    if (deletedDocumentIds.length === 0) return;
    if (!await this.authenticator.ensureAuthenticated()) return;

    const success = await this.syncer.sendDeletedDocuments(deletedDocumentIds);
    if (success) {
      this.data.settings.deletedDocumentIds = [];
      await this.persistData();
    }
  }

  async onunload(): Promise<void> {
    await this.persistData();
  }


  async persistData(): Promise<void> {
    await this.saveData(this.data);
  }
}



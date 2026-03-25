import { Notice, Plugin, TAbstractFile, TFile } from "obsidian";

import { FileSyncer } from "./syncer";
import { KnowmeldSettingTab } from "./settings";
import { DEFAULT_SETTINGS } from "./settings.store";
import { Authenticator } from "./authenticator";
import { CacheStore, SettingsStore } from "./store";
import { RealtimeSyncQueue } from "./realtime-sync";

export default class KnowmeldPlugin extends Plugin {
  private syncer!: FileSyncer;
  private settingTab!: KnowmeldSettingTab;
  private realtimeSync!: RealtimeSyncQueue;
  private authenticator!: Authenticator;
  private cacheStore!: CacheStore;
  private settingsStore!: SettingsStore;

  async onload(): Promise<void> {
    const loadedData = await this.loadData();

    const cacheData = CacheStore.fromRaw(loadedData?.cache || {});
    const mergedSettings = { ...DEFAULT_SETTINGS, ...loadedData?.settings };
    mergedSettings.apiUrl = DEFAULT_SETTINGS.apiUrl;
    mergedSettings.appUrl = DEFAULT_SETTINGS.appUrl;
    if (!mergedSettings.vaultId) {
      mergedSettings.vaultId = crypto.randomUUID();
    }
    mergedSettings.vaultName = this.app.vault.getName();

    this.cacheStore = new CacheStore(cacheData, () => this.persistData());
    this.settingsStore = new SettingsStore(mergedSettings);
    await this.persistData();

    this.authenticator = new Authenticator(this.settingsStore, this.cacheStore);
    this.settingTab = new KnowmeldSettingTab(this.app, this, this.settingsStore, this.authenticator, this.cacheStore);
    this.syncer = new FileSyncer(this.app, this.app.vault, this.cacheStore, this.settingsStore, this.authenticator);
    this.realtimeSync = new RealtimeSyncQueue(
      this.authenticator,
      this.syncer,
      this.app.vault,
      () => this.settingsStore.get().realtimeSyncInterval,
    );

    this.addSettingTab(this.settingTab);

    this.registerObsidianProtocolHandler("knowmeld-auth", async (params) => {
      const { pairingCode, correlationId } = params;
      if (!pairingCode || !correlationId) {
        new Notice("Knowmeld: Could not get connection parameters. Please try again.");
        return;
      }
      this.authenticator.finishPairing(pairingCode, correlationId).then(async (success) => {
        if (success) {
          await this.persistData();
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

    this.registerEvent(
      this.app.vault.on("modify", (file: TAbstractFile) => {
        if (!ready) return;
        if (file instanceof TFile && file.path.endsWith(".md")) {
          this.realtimeSync.queue(file.path);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("create", (file: TAbstractFile) => {
        if (!ready) return;
        if (file instanceof TFile && file.path.endsWith(".md")) {
          this.realtimeSync.queue(file.path);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file: TAbstractFile) => {
        if (!ready) return;
        if (file.path.endsWith(".md")) {
          const documentId = this.cacheStore.getDocumentId(file.path);
          if (documentId) {
            const ids = [...this.settingsStore.get().deletedDocumentIds, documentId];
            this.settingsStore.set({ deletedDocumentIds: ids });
          }
          this.syncer.handleDelete(file.path);
          this.persistData();
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
        if (!ready) return;
        if (file.path.endsWith(".md")) {
          this.syncer.handleRename(oldPath, file.path);
          this.realtimeSync.queue(file.path);
        }
      })
    );

    this.registerInterval(
      window.setInterval(() => this.realtimeSync.flush(), 5 * 60 * 1000)
    );
  }

  async onunload(): Promise<void> {
    await this.persistData();
  }

  async persistData(): Promise<void> {
    await this.saveData({
      cache: this.cacheStore?.getData() ?? {},
      settings: this.settingsStore?.get() ?? DEFAULT_SETTINGS,
    });
  }
}

import {
  App, Notice, PluginSettingTab, Setting,
} from "obsidian";
import type KnowmeldPlugin from "./main";
import { KnowmeldSettingStore } from "./settings.store";
import type { CacheStore } from "./store";

interface IAuthenticator {
  connect(isConnected: boolean): Promise<void>;
  disconnect(): Promise<void>;
}

export class KnowmeldSettingTab extends PluginSettingTab {
  plugin: KnowmeldPlugin;
  settingsStore: KnowmeldSettingStore;
  authenticator: IAuthenticator;
  cacheStore: CacheStore;

  constructor(app: App, plugin: KnowmeldPlugin, settingsStore: KnowmeldSettingStore, authenticator: IAuthenticator, cacheStore: CacheStore) {
    super(app, plugin);
    this.plugin = plugin;
    this.settingsStore = settingsStore;
    this.authenticator = authenticator;
    this.cacheStore = cacheStore;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const settings = this.settingsStore.get();
    const isConnected = settings.authDetails ? true : false;

    // Connect/Reconnect button

    new Setting(containerEl)
      .setName("Connect to Knowmeld")
      .setDesc("This registers your Obsidian with Knowmeld for sync")
      .addButton((btn) =>
        btn.setButtonText(isConnected ? "Reconnect" : "Connect").onClick(async () => {
          await this.authenticator.connect(isConnected);
          this.display(); // Refresh the settings UI
        })
      );


    // Disconnect button (only shown when connected)
    if (isConnected) {
      new Setting(containerEl)
        .setName("Disconnect from Knowmeld")
        .setDesc("Remove the connection to Knowmeld")
        .addButton((btn) =>
          btn
            .setButtonText("Disconnect")
            .setWarning()
            .onClick(async () => {
              await this.authenticator.disconnect();
              this.display(); // Refresh the settings UI
            })
        );
    }

    // Real-time sync interval slider
    new Setting(containerEl)
      .setName("Real-time sync interval")
      .setDesc(`Sync files automatically after this many minutes of inactivity (${Math.round(this.settingsStore.get().realtimeSyncInterval / 60)} min)`)
      .addSlider((slider) =>
        slider
          .setLimits(2, 10, 1)
          .setValue(Math.round(this.settingsStore.get().realtimeSyncInterval / 60))
          .setDynamicTooltip()
          .onChange(async (value) => {
            const seconds = Math.max(value, 2) * 60; // Enforce minimum of 2 minutes
            this.settingsStore.set({ realtimeSyncInterval: seconds });
            await this.plugin.persistData();
            this.display(); // Refresh to update description
          })
      );

    new Setting(containerEl)
      .setName("Clear sync cache")
      .setDesc("Force all files to be re-uploaded on next sync by clearing the local hash cache")
      .addButton((btn) =>
        btn
          .setButtonText("Clear cache")
          .setWarning()
          .onClick(async () => {
            await this.cacheStore.clear();
            new Notice("Knowmeld: Sync cache cleared");
          })
      );

    new Setting(containerEl)
      .setName("Excluded folders")
      .setDesc("Folders to exclude from syncing, separated by commas")
      .addText((text) => {
        text
          .setPlaceholder("e.g. Private,Templates")
          .setValue(this.settingsStore.get().excludedFolders.join(","))
          .onChange(async (value) => {
            const folders = value.split(",").map((folder) => folder.trim());
            this.settingsStore.set({ excludedFolders: folders });
            await this.plugin.persistData();
          });
      });
  }
}



import {
  App, PluginSettingTab, Setting,
} from "obsidian";
import type KnowmeldPlugin from "./main";
import { KnowmeldSettingStore } from "./settings.store";


export class KnowmeldSettingTab extends PluginSettingTab {
  plugin: KnowmeldPlugin;
  settingsStore: KnowmeldSettingStore;

  constructor(app: App, plugin: KnowmeldPlugin, settingsStore: KnowmeldSettingStore) {
    super(app, plugin);
    this.plugin = plugin;
    this.settingsStore = settingsStore;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("Connect to Knowmeld")
      .setDesc("This registers your Obsidian with Knowmeld for sync")
      .addButton((btn) =>
        btn.setButtonText("Connect").onClick(async () => {
          window.open(
            `${this.settingsStore.get().dashboardUrl}/dashboard/obsidian/connect?device_id=${this.settingsStore.get().deviceId}`
          )
        })).setDisabled(!!this.settingsStore.get().refreshToken);

    // new Setting(containerEl)
    //   .setName("Real-time sync")
    //   .setDesc("Automatically sync files when they are modified")
    //   .addToggle((toggle) =>
    //     toggle
    //       .setValue(this.settingsStore.get().realtimeSync)
    //       .onChange(async (value) => {
    //         this.settingsStore.set({ realtimeSync: value });
    //         await this.plugin.persistData();
    //       })
    //   );


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



var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => KnowmeldPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian4 = require("obsidian");

// src/syncer.ts
var import_obsidian = require("obsidian");
var MIN_CONTENT_LENGTH = 500;
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
var FileSyncer = class {
  constructor(app, vault, cacheStore, settingStore, authenticator) {
    this.vault = vault;
    this.cacheStore = cacheStore;
    this.settingsStore = settingStore;
    this.authenticator = authenticator;
    this.app = app;
  }
  async shouldSyncFile(file) {
    const settings = this.settingsStore.get();
    const content = await this.vault.read(file);
    let { contentStart } = (0, import_obsidian.getFrontMatterInfo)(content);
    contentStart = contentStart != null ? contentStart : 0;
    const contentWithoutFrontMatter = content.slice(contentStart);
    const hash = await hashContent(content);
    const cachedHash = this.cacheStore.get(file.path);
    if (settings.excludedFolders.some((folder) => file.path.startsWith(folder))) {
      return { shouldSync: false, reason: "path is in excluded folders" };
    }
    if (file.path.startsWith("_")) {
      return { shouldSync: false, reason: "path starts with underscore" };
    }
    if (!file.path.endsWith(".md")) {
      return { shouldSync: false, reason: "not a markdown file" };
    }
    if (contentWithoutFrontMatter !== void 0) {
      if (contentWithoutFrontMatter.trim().length < MIN_CONTENT_LENGTH) {
        return { shouldSync: false, reason: "content too short" };
      }
    }
    if (hash !== void 0 && cachedHash !== void 0) {
      if (hash === cachedHash) {
        return { shouldSync: false, reason: "content unchanged" };
      }
    }
    return { shouldSync: true, reason: "file should be synced" };
  }
  async uploadFile(file, sessionId) {
    const settings = this.settingsStore.get();
    if (!await this.authenticator.ensureAuthenticated()) {
      return 2 /* FAILED */;
    }
    const content = await this.vault.read(file);
    const hash = await hashContent(content);
    try {
      const formData = new FormData();
      const blob = new Blob([content], { type: "text/markdown" });
      const metadata = { vault_name: this.vault.getName() };
      formData.append("metadata", JSON.stringify(metadata));
      formData.append("file", blob, file.name);
      formData.append("file_path", file.path);
      formData.append("metadata", JSON.stringify(metadata));
      const response = await fetch(`${settings.apiUrl}/files/upload/file`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.authenticator.getAccessToken()}`,
          "X-Knowmeld-Correlation-ID": sessionId
        },
        body: formData
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const responseData = await response.json();
      this.cacheStore.set(file.path, hash);
      if (responseData.details.document_id) {
        this.cacheStore.setDocumentId(file.path, responseData.details.document_id);
      }
      await this.cacheStore.save();
      return 1 /* SYNC */;
    } catch (error) {
      new import_obsidian.Notice(`Knowmeld: Failed to sync ${file.name}`);
      console.error("Sync error:", error);
      return 2 /* FAILED */;
    }
  }
  async syncAll() {
    const files = this.vault.getMarkdownFiles();
    const filesToSync = [];
    for (const file of files) {
      const { shouldSync, reason } = await this.shouldSyncFile(file);
      if (!shouldSync) {
        console.log(`Skipping because file should not be synced: ${reason}`, file.path);
        continue;
      }
      filesToSync.push(file);
    }
    if (filesToSync.length === 0) {
      new import_obsidian.Notice("Knowmeld: No files to sync.");
      return;
    }
    await this.syncFiles(filesToSync);
  }
  async syncFiles(files) {
    let synced = 0;
    let skipped = 0;
    const sessionId = await this.startSync();
    if (!sessionId) {
      new import_obsidian.Notice("Knowmeld: Unable to start sync session.");
      return;
    }
    new import_obsidian.Notice(`Knowmeld: Syncing ${files.length} files...`);
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const wasUploaded = await this.uploadFile(file, sessionId);
      if (wasUploaded === 1 /* SYNC */)
        synced++;
      else if (wasUploaded === 0 /* SKIP */)
        skipped++;
      else {
        new import_obsidian.Notice(`Knowmeld: Stopping sync due to error.`);
        return;
      }
      await sleep(100);
    }
    if (synced) {
      new import_obsidian.Notice(`Knowmeld: Synced ${synced} files, ${skipped} unchanged`);
    }
    await this.finishSync(sessionId);
  }
  async syncFile(file) {
    const { shouldSync, reason } = await this.shouldSyncFile(file);
    if (!shouldSync) {
      new import_obsidian.Notice(`Knowmeld: File not synced: ${reason}`);
      console.log(`Skipping because file should not be synced: ${reason}`, file.path);
      return;
    }
    await this.syncFiles([file]);
  }
  async startSync() {
    if (!await this.authenticator.ensureAuthenticated()) {
      new import_obsidian.Notice("Knowmeld: Authentication required to start sync session.");
      return;
    }
    try {
      const resp = await fetch(`${this.settingsStore.get().apiUrl}/files/upload/start`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.authenticator.getAccessToken()}`,
          "X-Idempotency-Key": crypto.randomUUID()
        }
      });
      if (!resp.ok) {
        throw new Error("Authentication failed");
      }
      const sessionId = resp.headers.get("X-Knowmeld-Correlation-ID");
      if (!sessionId) {
        throw new Error("Knowmeld Error correlation ID missing in response");
      }
      return sessionId;
    } catch (error) {
      console.error("Sync start error:", error);
      new import_obsidian.Notice("Knowmeld: Failed to start sync session");
      return;
    }
  }
  async finishSync(sessionId) {
    if (!await this.authenticator.ensureAuthenticated()) {
      new import_obsidian.Notice("Knowmeld: Authentication required to finish sync session.");
      return;
    }
    try {
      await fetch(`${this.settingsStore.get().apiUrl}/files/upload/complete`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.authenticator.getAccessToken()}`,
          "Content-Type": "application/json",
          "X-Knowmeld-Correlation-ID": sessionId
        }
      });
      new import_obsidian.Notice("Knowmeld: Sync session completed successfully");
    } catch (error) {
      console.error("Sync finish error:", error);
      new import_obsidian.Notice("Knowmeld: Failed to finish sync session");
    }
  }
  // TODO: Delete should do more than just remove from the cache
  async handleDelete(path) {
    this.cacheStore.remove(path);
  }
  // TODO: Rename could notify the server of the change
  async handleRename(oldPath, newPath) {
    this.cacheStore.rename(oldPath, newPath);
  }
  async sendDeletedDocuments(documentIds) {
    if (documentIds.length === 0)
      return true;
    const settings = this.settingsStore.get();
    if (!await this.authenticator.ensureAuthenticated())
      return false;
    try {
      const response = await fetch(`${settings.apiUrl}/files/documents`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${this.authenticator.getAccessToken()}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ document_ids: documentIds })
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return true;
    } catch (error) {
      console.error("Failed to send deleted documents:", error);
      return false;
    }
  }
};
async function hashContent(content) {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// src/settings.ts
var import_obsidian2 = require("obsidian");
var KnowmeldSettingTab = class extends import_obsidian2.PluginSettingTab {
  constructor(app, plugin, settingsStore, authenticator) {
    super(app, plugin);
    this.plugin = plugin;
    this.settingsStore = settingsStore;
    this.authenticator = authenticator;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    const settings = this.settingsStore.get();
    const isConnected = settings.authDetails ? true : false;
    new import_obsidian2.Setting(containerEl).setName("Connect to Knowmeld").setDesc("This registers your Obsidian with Knowmeld for sync").addButton(
      (btn) => btn.setButtonText(isConnected ? "Reconnect" : "Connect").onClick(async () => {
        await this.authenticator.connect(isConnected);
        this.display();
      })
    );
    if (isConnected) {
      new import_obsidian2.Setting(containerEl).setName("Disconnect from Knowmeld").setDesc("Remove the connection to Knowmeld").addButton(
        (btn) => btn.setButtonText("Disconnect").setWarning().onClick(async () => {
          await this.authenticator.disconnect();
          this.display();
        })
      );
    }
    new import_obsidian2.Setting(containerEl).setName("Real-time sync interval").setDesc(`Sync files automatically after this many minutes of inactivity (${Math.round(this.settingsStore.get().realtimeSyncInterval / 60)} min)`).addSlider(
      (slider) => slider.setLimits(2, 10, 1).setValue(Math.round(this.settingsStore.get().realtimeSyncInterval / 60)).setDynamicTooltip().onChange(async (value) => {
        const seconds = Math.max(value, 2) * 60;
        this.settingsStore.set({ realtimeSyncInterval: seconds });
        await this.plugin.persistData();
        this.display();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Excluded folders").setDesc("Folders to exclude from syncing, separated by commas").addText((text) => {
      text.setPlaceholder("e.g. Private,Templates").setValue(this.settingsStore.get().excludedFolders.join(",")).onChange(async (value) => {
        const folders = value.split(",").map((folder) => folder.trim());
        this.settingsStore.set({ excludedFolders: folders });
        await this.plugin.persistData();
      });
    });
  }
};

// src/settings.store.ts
var DEFAULT_SETTINGS = {
  apiUrl: false ? "https://api.knowmeld.io/v1" : "http://localhost:8000/v1",
  dashboardUrl: false ? "https://dashboard.knowmeld.io" : "http://localhost:8000",
  authDetails: void 0,
  excludedFolders: [],
  realtimeSyncInterval: 120,
  deletedDocumentIds: []
};

// src/authenticator.ts
var import_obsidian3 = require("obsidian");
var Authenticator = class {
  constructor(settingsStore, cacheStore) {
    this.settingsStore = settingsStore;
    this.cacheStore = cacheStore;
  }
  static getAuthHeader(accessToken) {
    return {
      Authorization: `Bearer ${accessToken}`
    };
  }
  async authenticate() {
    const settings = this.settingsStore.get();
    if (!settings.authDetails) {
      return false;
    }
    try {
      const formData = new FormData();
      formData.append("refresh_token", settings.authDetails.refreshToken);
      const response = await fetch(`${settings.apiUrl}/auth/token/refresh`, {
        method: "POST",
        body: formData
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = await response.json();
      const { token_id, access_token, refresh_token, access_token_expires_at, refresh_token_expires_at } = data;
      this.persistAuthDetails(
        token_id,
        access_token,
        access_token_expires_at,
        refresh_token,
        refresh_token_expires_at
      );
      await this.cacheStore.save();
      return true;
    } catch (error) {
      console.error("Authentication error:", error);
      new import_obsidian3.Notice("Knowmeld: Authentication failed. Please reconnect your device in the settings.");
      return false;
    }
  }
  persistAuthDetails(tokenID, accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt) {
    this.settingsStore.set({
      authDetails: {
        tokenID,
        accessToken,
        accessTokenExpiresAt: accessTokenExpiresAt * 1e3,
        refreshToken,
        refreshTokenExpiresAt: refreshTokenExpiresAt * 1e3
      }
    });
    this.cacheStore.save();
  }
  async connect() {
    const settings = this.settingsStore.get();
    window.open(
      `${settings.dashboardUrl}/dashboard/connect?connector=obsidian`
    );
  }
  isConnected() {
    const settings = this.settingsStore.get();
    return !!settings.authDetails;
  }
  isAuthenticated() {
    if (!this.isConnected())
      return false;
    const settings = this.settingsStore.get();
    const bufferMs = 60 * 1e3;
    const now = Date.now();
    return settings.authDetails.accessTokenExpiresAt - bufferMs > now;
  }
  async ensureAuthenticated() {
    if (this.isAuthenticated())
      return true;
    return await this.authenticate();
  }
  async disconnect() {
    const settings = this.settingsStore.get();
    if (!settings.authDetails)
      return;
    if (!await this.ensureAuthenticated())
      return;
    const formData = new FormData();
    formData.append("token_id", settings.authDetails.tokenID);
    try {
      const response = await fetch(`${settings.apiUrl}/auth/revoke`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.getAccessToken()}`
        },
        body: formData
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      this.settingsStore.set({ authDetails: null });
      await this.cacheStore.save();
    } catch (error) {
      console.error("Disconnect error:", error);
      new import_obsidian3.Notice("Knowmeld: Failed to disconnect from Knowmeld.");
    }
  }
  getAccessToken() {
    var _a;
    const settings = this.settingsStore.get();
    return ((_a = settings.authDetails) == null ? void 0 : _a.accessToken) || "";
  }
  async finishPairing(pairingCode, correlationId) {
    const settings = this.settingsStore.get();
    const formData = new FormData();
    formData.append("pairing_code", pairingCode);
    const resp = await fetch(`${settings.apiUrl}/auth/token/pair`, {
      method: "POST",
      body: formData,
      headers: {
        "X-Knowmeld-Correlation-ID": correlationId
      }
    });
    if (!resp.ok) {
      new import_obsidian3.Notice("Knowmeld: Failed to connect device.");
      return false;
    }
    const data = await resp.json();
    if (data.access_token && data.refresh_token) {
      this.persistAuthDetails(
        data.token_id,
        data.access_token,
        data.access_token_expires_at,
        data.refresh_token,
        data.refresh_token_expires_at
      );
    }
    return true;
  }
};

// src/main.ts
var KnowmeldPlugin = class extends import_obsidian4.Plugin {
  constructor() {
    super(...arguments);
    this.pendingFiles = /* @__PURE__ */ new Set();
    this.syncTimeout = null;
    this.syncing = false;
    this.data = {
      cache: {},
      settings: DEFAULT_SETTINGS
    };
  }
  async onload() {
    const loadedData = await this.loadData();
    const rawCache = (loadedData == null ? void 0 : loadedData.cache) || {};
    const migratedCache = {};
    for (const [path, value] of Object.entries(rawCache)) {
      if (typeof value === "string") {
        migratedCache[path] = { hash: value };
      } else {
        migratedCache[path] = value;
      }
    }
    this.data = {
      cache: migratedCache,
      settings: { ...DEFAULT_SETTINGS, ...loadedData == null ? void 0 : loadedData.settings }
    };
    const cacheStore = {
      get: (path) => {
        var _a;
        return (_a = this.data.cache[path]) == null ? void 0 : _a.hash;
      },
      set: (path, hash) => {
        const existing = this.data.cache[path];
        this.data.cache[path] = { ...existing, hash };
      },
      remove: (path) => {
        delete this.data.cache[path];
      },
      rename: (oldPath, newPath) => {
        if (this.data.cache[oldPath]) {
          this.data.cache[newPath] = this.data.cache[oldPath];
          delete this.data.cache[oldPath];
        }
      },
      getDocumentId: (path) => {
        var _a;
        return (_a = this.data.cache[path]) == null ? void 0 : _a.documentId;
      },
      setDocumentId: (path, documentId) => {
        if (this.data.cache[path]) {
          this.data.cache[path].documentId = documentId;
        }
      },
      save: async () => {
        await this.persistData();
      }
    };
    const settingsStore = {
      get: () => this.data.settings,
      set: (setting) => {
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
        new import_obsidian4.Notice("Knowmeld: Could not get connection parameters. Please try again.");
        return;
      }
      this.authenticator.finishPairing(pairingCode, correlationId).then(async (success) => {
        if (success) {
          new import_obsidian4.Notice("Knowmeld: Device successfully connected!");
          this.settingTab.display();
        } else {
          new import_obsidian4.Notice("Knowmeld: Failed to connect device. Could not retrieve code from server. Please try again.");
        }
      });
    });
    this.addRibbonIcon("refresh-cw", "Sync all to Knowmeld", async () => {
      await this.syncer.syncAll();
    });
    this.addCommand({
      id: "sync-all",
      name: "Sync all files to Knowmeld",
      checkCallback: (checking) => {
        const connected = this.authenticator.isConnected();
        if (checking)
          return connected;
        if (!connected) {
          new import_obsidian4.Notice("Knowmeld: Your device has not been connected. Please connect in the settings.");
          return false;
        }
        this.syncer.syncAll();
        return true;
      }
    });
    this.addCommand({
      id: "sync-current",
      name: "Sync current file to Knowmeld",
      checkCallback: (checking) => {
        const connected = this.authenticator.isConnected();
        const file = this.app.workspace.getActiveFile();
        const ok = !!(connected && file && file.path.endsWith(".md"));
        if (checking)
          return ok;
        if (!connected) {
          new import_obsidian4.Notice("Knowmeld: Your device has not been connected. Please connect in the settings.");
          return false;
        }
        if (file && file.path.endsWith(".md")) {
          this.syncer.syncFile(file);
          return true;
        }
        return false;
      }
    });
    let ready = false;
    this.app.workspace.onLayoutReady(() => {
      if (ready)
        return;
      ready = true;
    });
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!ready)
          return;
        if (file instanceof import_obsidian4.TFile && file.path.endsWith(".md")) {
          this.queueFileForSync(file.path);
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (!ready)
          return;
        if (file instanceof import_obsidian4.TFile && file.path.endsWith(".md")) {
          console.log(`Knowmeld: Queuing created file ${file.path}`);
          this.queueFileForSync(file.path);
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        var _a;
        if (!ready)
          return;
        if (file.path.endsWith(".md")) {
          console.log(`Knowmeld: Queuing deleted file ${file.path}`);
          const documentId = (_a = this.data.cache[file.path]) == null ? void 0 : _a.documentId;
          if (documentId) {
            this.data.settings.deletedDocumentIds.push(documentId);
          }
          this.syncer.handleDelete(file.path);
          this.persistData();
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (!ready)
          return;
        if (file.path.endsWith(".md")) {
          console.log(`Knowmeld: Handling renamed file ${oldPath} -> ${file.path}`);
          this.syncer.handleRename(oldPath, file.path);
          this.queueFileForSync(file.path);
        }
      })
    );
    this.registerInterval(
      window.setInterval(() => this.flushDeletedFiles(), 5 * 60 * 1e3)
    );
  }
  queueFileForSync(path) {
    if (!this.authenticator.isConnected())
      return;
    this.pendingFiles.add(path);
    if (this.syncTimeout) {
      clearTimeout(this.syncTimeout);
    }
    const intervalMs = this.data.settings.realtimeSyncInterval * 1e3;
    this.syncTimeout = setTimeout(() => {
      this.syncPendingFiles();
    }, intervalMs);
  }
  async syncPendingFiles() {
    if (this.syncing)
      return;
    if (this.pendingFiles.size === 0)
      return;
    this.syncing = true;
    try {
      if (!await this.authenticator.ensureAuthenticated())
        return;
      const filesToSync = Array.from(this.pendingFiles);
      this.pendingFiles.clear();
      this.syncTimeout = null;
      console.log(`Knowmeld: Syncing ${filesToSync.length} pending files...`);
      const files = [];
      for (const path of filesToSync) {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof import_obsidian4.TFile) {
          files.push(file);
        }
      }
      if (files.length === 0)
        return;
      await this.syncer.syncFiles(files);
    } finally {
      this.syncing = false;
    }
  }
  async flushDeletedFiles() {
    const deletedDocumentIds = this.data.settings.deletedDocumentIds;
    if (deletedDocumentIds.length === 0)
      return;
    if (!await this.authenticator.ensureAuthenticated())
      return;
    const success = await this.syncer.sendDeletedDocuments(deletedDocumentIds);
    if (success) {
      this.data.settings.deletedDocumentIds = [];
      await this.persistData();
    }
  }
  async onunload() {
    await this.persistData();
  }
  async persistData() {
    await this.saveData(this.data);
  }
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vc3JjL21haW4udHMiLCAiLi4vc3JjL3N5bmNlci50cyIsICIuLi9zcmMvc2V0dGluZ3MudHMiLCAiLi4vc3JjL3NldHRpbmdzLnN0b3JlLnRzIiwgIi4uL3NyYy9hdXRoZW50aWNhdG9yLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgeyBOb3RpY2UsIFBsdWdpbiwgVEFic3RyYWN0RmlsZSwgVEZpbGUgfSBmcm9tIFwib2JzaWRpYW5cIjtcblxuaW1wb3J0IHsgRmlsZVN5bmNlciB9IGZyb20gXCIuL3N5bmNlclwiO1xuaW1wb3J0IHsgS25vd21lbGRTZXR0aW5nVGFiIH0gZnJvbSBcIi4vc2V0dGluZ3NcIjtcbmltcG9ydCB7IERFRkFVTFRfU0VUVElOR1MsIEtub3dtZWxkU2V0dGluZ3MgfSBmcm9tIFwiLi9zZXR0aW5ncy5zdG9yZVwiO1xuaW1wb3J0IHsgQXV0aGVudGljYXRvciB9IGZyb20gXCIuL2F1dGhlbnRpY2F0b3JcIjtcblxuaW50ZXJmYWNlIENhY2hlRW50cnkge1xuICBoYXNoOiBzdHJpbmc7XG4gIGRvY3VtZW50SWQ/OiBzdHJpbmc7XG59XG5cbmludGVyZmFjZSBDYWNoZURhdGEge1xuICBbcGF0aDogc3RyaW5nXTogQ2FjaGVFbnRyeTtcbn1cblxudHlwZSBQZXJzaXN0ZWREYXRhID0ge1xuICBjYWNoZTogQ2FjaGVEYXRhO1xuICBsb2c/OiBzdHJpbmc7XG4gIHNldHRpbmdzOiBLbm93bWVsZFNldHRpbmdzO1xufVxuXG5pbnRlcmZhY2UgUGVyc2lzdGVkQ2FjaGUge1xuICBnZXQocGF0aDogc3RyaW5nKTogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICBzZXQocGF0aDogc3RyaW5nLCBoYXNoOiBzdHJpbmcpOiB2b2lkO1xuICByZW1vdmUocGF0aDogc3RyaW5nKTogdm9pZDtcbiAgcmVuYW1lKG9sZFBhdGg6IHN0cmluZywgbmV3UGF0aDogc3RyaW5nKTogdm9pZDtcbiAgZ2V0RG9jdW1lbnRJZChwYXRoOiBzdHJpbmcpOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIHNldERvY3VtZW50SWQocGF0aDogc3RyaW5nLCBkb2N1bWVudElkOiBzdHJpbmcpOiB2b2lkO1xuICBzYXZlKCk6IFByb21pc2U8dm9pZD47XG59XG5cbmV4cG9ydCBkZWZhdWx0IGNsYXNzIEtub3dtZWxkUGx1Z2luIGV4dGVuZHMgUGx1Z2luIHtcbiAgcHJpdmF0ZSBzeW5jZXIhOiBGaWxlU3luY2VyO1xuICBwcml2YXRlIHNldHRpbmdUYWIhOiBLbm93bWVsZFNldHRpbmdUYWI7XG4gIHByaXZhdGUgcGVuZGluZ0ZpbGVzOiBTZXQ8c3RyaW5nPiA9IG5ldyBTZXQoKTtcbiAgcHJpdmF0ZSBzeW5jVGltZW91dDogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBhdXRoZW50aWNhdG9yITogQXV0aGVudGljYXRvcjtcbiAgcHJpdmF0ZSBzeW5jaW5nOiBib29sZWFuID0gZmFsc2U7XG5cbiAgcHJpdmF0ZSBkYXRhOiBQZXJzaXN0ZWREYXRhID0ge1xuICAgIGNhY2hlOiB7fSxcbiAgICBzZXR0aW5nczogREVGQVVMVF9TRVRUSU5HUyxcbiAgfTtcblxuICBhc3luYyBvbmxvYWQoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3QgbG9hZGVkRGF0YSA9IGF3YWl0IHRoaXMubG9hZERhdGEoKTtcbiAgICAvLyBNaWdyYXRlIG9sZCBjYWNoZSBmb3JtYXQgKHN0cmluZyBoYXNoKSB0byBuZXcgZm9ybWF0ICh7IGhhc2gsIGRvY3VtZW50SWQgfSlcbiAgICBjb25zdCByYXdDYWNoZSA9IGxvYWRlZERhdGE/LmNhY2hlIHx8IHt9O1xuICAgIGNvbnN0IG1pZ3JhdGVkQ2FjaGU6IENhY2hlRGF0YSA9IHt9O1xuICAgIGZvciAoY29uc3QgW3BhdGgsIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhyYXdDYWNoZSkpIHtcbiAgICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgIG1pZ3JhdGVkQ2FjaGVbcGF0aF0gPSB7IGhhc2g6IHZhbHVlIH07XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBtaWdyYXRlZENhY2hlW3BhdGhdID0gdmFsdWUgYXMgQ2FjaGVFbnRyeTtcbiAgICAgIH1cbiAgICB9XG4gICAgdGhpcy5kYXRhID0ge1xuICAgICAgY2FjaGU6IG1pZ3JhdGVkQ2FjaGUsXG4gICAgICBzZXR0aW5nczogeyAuLi5ERUZBVUxUX1NFVFRJTkdTLCAuLi5sb2FkZWREYXRhPy5zZXR0aW5ncyB9LFxuICAgIH1cbiAgICBjb25zdCBjYWNoZVN0b3JlOiBQZXJzaXN0ZWRDYWNoZSA9IHtcbiAgICAgIGdldDogKHBhdGg6IHN0cmluZykgPT4gdGhpcy5kYXRhLmNhY2hlW3BhdGhdPy5oYXNoLFxuICAgICAgc2V0OiAocGF0aDogc3RyaW5nLCBoYXNoOiBzdHJpbmcpID0+IHtcbiAgICAgICAgY29uc3QgZXhpc3RpbmcgPSB0aGlzLmRhdGEuY2FjaGVbcGF0aF07XG4gICAgICAgIHRoaXMuZGF0YS5jYWNoZVtwYXRoXSA9IHsgLi4uZXhpc3RpbmcsIGhhc2ggfTtcbiAgICAgIH0sXG4gICAgICByZW1vdmU6IChwYXRoOiBzdHJpbmcpID0+IHtcbiAgICAgICAgZGVsZXRlIHRoaXMuZGF0YS5jYWNoZVtwYXRoXTtcbiAgICAgIH0sXG4gICAgICByZW5hbWU6IChvbGRQYXRoOiBzdHJpbmcsIG5ld1BhdGg6IHN0cmluZykgPT4ge1xuICAgICAgICBpZiAodGhpcy5kYXRhLmNhY2hlW29sZFBhdGhdKSB7XG4gICAgICAgICAgdGhpcy5kYXRhLmNhY2hlW25ld1BhdGhdID0gdGhpcy5kYXRhLmNhY2hlW29sZFBhdGhdO1xuICAgICAgICAgIGRlbGV0ZSB0aGlzLmRhdGEuY2FjaGVbb2xkUGF0aF07XG4gICAgICAgIH1cbiAgICAgIH0sXG4gICAgICBnZXREb2N1bWVudElkOiAocGF0aDogc3RyaW5nKSA9PiB0aGlzLmRhdGEuY2FjaGVbcGF0aF0/LmRvY3VtZW50SWQsXG4gICAgICBzZXREb2N1bWVudElkOiAocGF0aDogc3RyaW5nLCBkb2N1bWVudElkOiBzdHJpbmcpID0+IHtcbiAgICAgICAgaWYgKHRoaXMuZGF0YS5jYWNoZVtwYXRoXSkge1xuICAgICAgICAgIHRoaXMuZGF0YS5jYWNoZVtwYXRoXS5kb2N1bWVudElkID0gZG9jdW1lbnRJZDtcbiAgICAgICAgfVxuICAgICAgfSxcbiAgICAgIHNhdmU6IGFzeW5jICgpID0+IHtcbiAgICAgICAgYXdhaXQgdGhpcy5wZXJzaXN0RGF0YSgpO1xuICAgICAgfVxuICAgIH1cbiAgICBjb25zdCBzZXR0aW5nc1N0b3JlID0ge1xuICAgICAgZ2V0OiAoKTogS25vd21lbGRTZXR0aW5ncyA9PiB0aGlzLmRhdGEuc2V0dGluZ3MsXG4gICAgICBzZXQ6IChzZXR0aW5nOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuIHwgbnVtYmVyIHwgc3RyaW5nW10+KTogdm9pZCA9PiB7XG4gICAgICAgIHRoaXMuZGF0YS5zZXR0aW5ncyA9IHsgLi4udGhpcy5kYXRhLnNldHRpbmdzLCAuLi5zZXR0aW5nIH07XG4gICAgICB9XG4gICAgfTtcbiAgICB0aGlzLmF1dGhlbnRpY2F0b3IgPSBuZXcgQXV0aGVudGljYXRvcihzZXR0aW5nc1N0b3JlLCBjYWNoZVN0b3JlKTtcbiAgICB0aGlzLnNldHRpbmdUYWIgPSBuZXcgS25vd21lbGRTZXR0aW5nVGFiKHRoaXMuYXBwLCB0aGlzLCBzZXR0aW5nc1N0b3JlLCB0aGlzLmF1dGhlbnRpY2F0b3IpO1xuICAgIHRoaXMuc3luY2VyID0gbmV3IEZpbGVTeW5jZXIodGhpcy5hcHAsIHRoaXMuYXBwLnZhdWx0LCBjYWNoZVN0b3JlLCBzZXR0aW5nc1N0b3JlLCB0aGlzLmF1dGhlbnRpY2F0b3IpO1xuICAgIHRoaXMuYWRkU2V0dGluZ1RhYih0aGlzLnNldHRpbmdUYWIpO1xuICAgIHRoaXMucmVnaXN0ZXJPYnNpZGlhblByb3RvY29sSGFuZGxlcihcImtub3dtZWxkLWF1dGhcIiwgYXN5bmMgKHBhcmFtcykgPT4ge1xuICAgICAgY29uc3QgeyBwYWlyaW5nQ29kZSwgY29ycmVsYXRpb25JZCB9ID0gcGFyYW1zO1xuICAgICAgaWYgKCFwYWlyaW5nQ29kZSB8fCAhY29ycmVsYXRpb25JZCkge1xuICAgICAgICBuZXcgTm90aWNlKFwiS25vd21lbGQ6IENvdWxkIG5vdCBnZXQgY29ubmVjdGlvbiBwYXJhbWV0ZXJzLiBQbGVhc2UgdHJ5IGFnYWluLlwiKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgdGhpcy5hdXRoZW50aWNhdG9yLmZpbmlzaFBhaXJpbmcocGFpcmluZ0NvZGUsIGNvcnJlbGF0aW9uSWQpLnRoZW4oYXN5bmMgKHN1Y2Nlc3MpID0+IHtcbiAgICAgICAgaWYgKHN1Y2Nlc3MpIHtcbiAgICAgICAgICBuZXcgTm90aWNlKFwiS25vd21lbGQ6IERldmljZSBzdWNjZXNzZnVsbHkgY29ubmVjdGVkIVwiKTtcbiAgICAgICAgICB0aGlzLnNldHRpbmdUYWIuZGlzcGxheSgpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIG5ldyBOb3RpY2UoXCJLbm93bWVsZDogRmFpbGVkIHRvIGNvbm5lY3QgZGV2aWNlLiBDb3VsZCBub3QgcmV0cmlldmUgY29kZSBmcm9tIHNlcnZlci4gUGxlYXNlIHRyeSBhZ2Fpbi5cIik7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGhpcy5hZGRSaWJib25JY29uKFwicmVmcmVzaC1jd1wiLCBcIlN5bmMgYWxsIHRvIEtub3dtZWxkXCIsIGFzeW5jICgpID0+IHtcbiAgICAgIGF3YWl0IHRoaXMuc3luY2VyLnN5bmNBbGwoKTtcbiAgICB9KTtcblxuICAgIHRoaXMuYWRkQ29tbWFuZCh7XG4gICAgICBpZDogXCJzeW5jLWFsbFwiLFxuICAgICAgbmFtZTogXCJTeW5jIGFsbCBmaWxlcyB0byBLbm93bWVsZFwiLFxuICAgICAgY2hlY2tDYWxsYmFjazogKGNoZWNraW5nOiBib29sZWFuKSA9PiB7XG4gICAgICAgIGNvbnN0IGNvbm5lY3RlZCA9IHRoaXMuYXV0aGVudGljYXRvci5pc0Nvbm5lY3RlZCgpO1xuXG4gICAgICAgIGlmIChjaGVja2luZykgcmV0dXJuIGNvbm5lY3RlZDtcblxuICAgICAgICBpZiAoIWNvbm5lY3RlZCkge1xuICAgICAgICAgIG5ldyBOb3RpY2UoXCJLbm93bWVsZDogWW91ciBkZXZpY2UgaGFzIG5vdCBiZWVuIGNvbm5lY3RlZC4gUGxlYXNlIGNvbm5lY3QgaW4gdGhlIHNldHRpbmdzLlwiKTtcbiAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgIH1cblxuICAgICAgICB0aGlzLnN5bmNlci5zeW5jQWxsKCk7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfSxcbiAgICB9KTtcblxuICAgIHRoaXMuYWRkQ29tbWFuZCh7XG4gICAgICBpZDogXCJzeW5jLWN1cnJlbnRcIixcbiAgICAgIG5hbWU6IFwiU3luYyBjdXJyZW50IGZpbGUgdG8gS25vd21lbGRcIixcbiAgICAgIGNoZWNrQ2FsbGJhY2s6IChjaGVja2luZzogYm9vbGVhbikgPT4ge1xuICAgICAgICBjb25zdCBjb25uZWN0ZWQgPSB0aGlzLmF1dGhlbnRpY2F0b3IuaXNDb25uZWN0ZWQoKTtcbiAgICAgICAgY29uc3QgZmlsZSA9IHRoaXMuYXBwLndvcmtzcGFjZS5nZXRBY3RpdmVGaWxlKCk7XG4gICAgICAgIGNvbnN0IG9rID0gISEoY29ubmVjdGVkICYmIGZpbGUgJiYgZmlsZS5wYXRoLmVuZHNXaXRoKFwiLm1kXCIpKTtcblxuICAgICAgICBpZiAoY2hlY2tpbmcpIHJldHVybiBvaztcblxuICAgICAgICBpZiAoIWNvbm5lY3RlZCkge1xuICAgICAgICAgIG5ldyBOb3RpY2UoXCJLbm93bWVsZDogWW91ciBkZXZpY2UgaGFzIG5vdCBiZWVuIGNvbm5lY3RlZC4gUGxlYXNlIGNvbm5lY3QgaW4gdGhlIHNldHRpbmdzLlwiKTtcbiAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGZpbGUgJiYgZmlsZS5wYXRoLmVuZHNXaXRoKFwiLm1kXCIpKSB7XG4gICAgICAgICAgdGhpcy5zeW5jZXIuc3luY0ZpbGUoZmlsZSk7XG4gICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgfSxcbiAgICB9KTtcblxuXG4gICAgbGV0IHJlYWR5ID0gZmFsc2U7XG4gICAgdGhpcy5hcHAud29ya3NwYWNlLm9uTGF5b3V0UmVhZHkoKCkgPT4ge1xuICAgICAgaWYgKHJlYWR5KSByZXR1cm47XG4gICAgICByZWFkeSA9IHRydWU7XG4gICAgfSk7XG5cbiAgICAvLyBSZWFsLXRpbWUgc3luYzogcXVldWUgZmlsZXMgb24gbW9kaWZ5L2NyZWF0ZVxuICAgIHRoaXMucmVnaXN0ZXJFdmVudChcbiAgICAgIHRoaXMuYXBwLnZhdWx0Lm9uKFwibW9kaWZ5XCIsIChmaWxlOiBUQWJzdHJhY3RGaWxlKSA9PiB7XG4gICAgICAgIGlmICghcmVhZHkpIHJldHVybjtcbiAgICAgICAgaWYgKGZpbGUgaW5zdGFuY2VvZiBURmlsZSAmJiBmaWxlLnBhdGguZW5kc1dpdGgoXCIubWRcIikpIHtcbiAgICAgICAgICB0aGlzLnF1ZXVlRmlsZUZvclN5bmMoZmlsZS5wYXRoKTtcbiAgICAgICAgfVxuICAgICAgfSlcbiAgICApO1xuXG4gICAgdGhpcy5yZWdpc3RlckV2ZW50KFxuICAgICAgdGhpcy5hcHAudmF1bHQub24oXCJjcmVhdGVcIiwgKGZpbGU6IFRBYnN0cmFjdEZpbGUpID0+IHtcbiAgICAgICAgaWYgKCFyZWFkeSkgcmV0dXJuO1xuICAgICAgICBpZiAoZmlsZSBpbnN0YW5jZW9mIFRGaWxlICYmIGZpbGUucGF0aC5lbmRzV2l0aChcIi5tZFwiKSkge1xuICAgICAgICAgIGNvbnNvbGUubG9nKGBLbm93bWVsZDogUXVldWluZyBjcmVhdGVkIGZpbGUgJHtmaWxlLnBhdGh9YCk7XG4gICAgICAgICAgdGhpcy5xdWV1ZUZpbGVGb3JTeW5jKGZpbGUucGF0aCk7XG4gICAgICAgIH1cbiAgICAgIH0pXG4gICAgKTtcblxuICAgIC8vIFRyYWNrIGRlbGV0ZWQgZmlsZXMgZm9yIGJhdGNoIG5vdGlmaWNhdGlvblxuICAgIHRoaXMucmVnaXN0ZXJFdmVudChcbiAgICAgIHRoaXMuYXBwLnZhdWx0Lm9uKFwiZGVsZXRlXCIsIChmaWxlOiBUQWJzdHJhY3RGaWxlKSA9PiB7XG4gICAgICAgIGlmICghcmVhZHkpIHJldHVybjtcbiAgICAgICAgaWYgKGZpbGUucGF0aC5lbmRzV2l0aChcIi5tZFwiKSkge1xuICAgICAgICAgIGNvbnNvbGUubG9nKGBLbm93bWVsZDogUXVldWluZyBkZWxldGVkIGZpbGUgJHtmaWxlLnBhdGh9YCk7XG4gICAgICAgICAgY29uc3QgZG9jdW1lbnRJZCA9IHRoaXMuZGF0YS5jYWNoZVtmaWxlLnBhdGhdPy5kb2N1bWVudElkO1xuICAgICAgICAgIGlmIChkb2N1bWVudElkKSB7XG4gICAgICAgICAgICB0aGlzLmRhdGEuc2V0dGluZ3MuZGVsZXRlZERvY3VtZW50SWRzLnB1c2goZG9jdW1lbnRJZCk7XG4gICAgICAgICAgfVxuICAgICAgICAgIHRoaXMuc3luY2VyLmhhbmRsZURlbGV0ZShmaWxlLnBhdGgpO1xuICAgICAgICAgIHRoaXMucGVyc2lzdERhdGEoKTtcbiAgICAgICAgfVxuICAgICAgfSlcbiAgICApO1xuXG4gICAgLy8gSGFuZGxlIHJlbmFtZXM6IHJlbW92ZSBvbGQgcGF0aCBmcm9tIGNhY2hlLCBxdWV1ZSBuZXcgcGF0aCBmb3Igc3luY1xuICAgIHRoaXMucmVnaXN0ZXJFdmVudChcbiAgICAgIHRoaXMuYXBwLnZhdWx0Lm9uKFwicmVuYW1lXCIsIChmaWxlOiBUQWJzdHJhY3RGaWxlLCBvbGRQYXRoOiBzdHJpbmcpID0+IHtcbiAgICAgICAgaWYgKCFyZWFkeSkgcmV0dXJuO1xuICAgICAgICBpZiAoZmlsZS5wYXRoLmVuZHNXaXRoKFwiLm1kXCIpKSB7XG4gICAgICAgICAgY29uc29sZS5sb2coYEtub3dtZWxkOiBIYW5kbGluZyByZW5hbWVkIGZpbGUgJHtvbGRQYXRofSAtPiAke2ZpbGUucGF0aH1gKTtcbiAgICAgICAgICB0aGlzLnN5bmNlci5oYW5kbGVSZW5hbWUob2xkUGF0aCwgZmlsZS5wYXRoKTtcbiAgICAgICAgICB0aGlzLnF1ZXVlRmlsZUZvclN5bmMoZmlsZS5wYXRoKTtcbiAgICAgICAgfVxuICAgICAgfSlcbiAgICApO1xuXG4gICAgLy8gRmx1c2ggZGVsZXRlZCBmaWxlcyBldmVyeSAxMCBtaW51dGVzXG4gICAgdGhpcy5yZWdpc3RlckludGVydmFsKFxuICAgICAgd2luZG93LnNldEludGVydmFsKCgpID0+IHRoaXMuZmx1c2hEZWxldGVkRmlsZXMoKSwgNSAqIDYwICogMTAwMClcbiAgICApO1xuICB9XG5cblxuICBwcml2YXRlIHF1ZXVlRmlsZUZvclN5bmMocGF0aDogc3RyaW5nKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLmF1dGhlbnRpY2F0b3IuaXNDb25uZWN0ZWQoKSkgcmV0dXJuO1xuICAgIHRoaXMucGVuZGluZ0ZpbGVzLmFkZChwYXRoKTtcblxuICAgIC8vIENsZWFyIGV4aXN0aW5nIHRpbWVvdXRcbiAgICBpZiAodGhpcy5zeW5jVGltZW91dCkge1xuICAgICAgY2xlYXJUaW1lb3V0KHRoaXMuc3luY1RpbWVvdXQpO1xuICAgIH1cblxuICAgIC8vIFNldCBuZXcgdGltZW91dCBiYXNlZCBvbiBjb25maWd1cmVkIGludGVydmFsXG4gICAgY29uc3QgaW50ZXJ2YWxNcyA9IHRoaXMuZGF0YS5zZXR0aW5ncy5yZWFsdGltZVN5bmNJbnRlcnZhbCAqIDEwMDA7XG4gICAgdGhpcy5zeW5jVGltZW91dCA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgdGhpcy5zeW5jUGVuZGluZ0ZpbGVzKCk7XG4gICAgfSwgaW50ZXJ2YWxNcyk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHN5bmNQZW5kaW5nRmlsZXMoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKHRoaXMuc3luY2luZykgcmV0dXJuO1xuICAgIGlmICh0aGlzLnBlbmRpbmdGaWxlcy5zaXplID09PSAwKSByZXR1cm47XG4gICAgdGhpcy5zeW5jaW5nID0gdHJ1ZTtcbiAgICB0cnkge1xuICAgICAgaWYgKCFhd2FpdCB0aGlzLmF1dGhlbnRpY2F0b3IuZW5zdXJlQXV0aGVudGljYXRlZCgpKSByZXR1cm47XG5cbiAgICAgIGNvbnN0IGZpbGVzVG9TeW5jID0gQXJyYXkuZnJvbSh0aGlzLnBlbmRpbmdGaWxlcyk7XG4gICAgICB0aGlzLnBlbmRpbmdGaWxlcy5jbGVhcigpO1xuICAgICAgdGhpcy5zeW5jVGltZW91dCA9IG51bGw7XG4gICAgICBjb25zb2xlLmxvZyhgS25vd21lbGQ6IFN5bmNpbmcgJHtmaWxlc1RvU3luYy5sZW5ndGh9IHBlbmRpbmcgZmlsZXMuLi5gKTtcblxuICAgICAgLy8gR2V0IFRGaWxlIG9iamVjdHMgZm9yIHBlbmRpbmcgcGF0aHNcbiAgICAgIGNvbnN0IGZpbGVzOiBURmlsZVtdID0gW107XG4gICAgICBmb3IgKGNvbnN0IHBhdGggb2YgZmlsZXNUb1N5bmMpIHtcbiAgICAgICAgY29uc3QgZmlsZSA9IHRoaXMuYXBwLnZhdWx0LmdldEFic3RyYWN0RmlsZUJ5UGF0aChwYXRoKTtcbiAgICAgICAgaWYgKGZpbGUgaW5zdGFuY2VvZiBURmlsZSkge1xuICAgICAgICAgIGZpbGVzLnB1c2goZmlsZSk7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgaWYgKGZpbGVzLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuXG4gICAgICAvLyBTeW5jIHBlbmRpbmcgZmlsZXNcbiAgICAgIGF3YWl0IHRoaXMuc3luY2VyLnN5bmNGaWxlcyhmaWxlcyk7XG5cbiAgICB9IGZpbmFsbHkge1xuICAgICAgdGhpcy5zeW5jaW5nID0gZmFsc2U7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBmbHVzaERlbGV0ZWRGaWxlcygpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCBkZWxldGVkRG9jdW1lbnRJZHMgPSB0aGlzLmRhdGEuc2V0dGluZ3MuZGVsZXRlZERvY3VtZW50SWRzO1xuICAgIGlmIChkZWxldGVkRG9jdW1lbnRJZHMubGVuZ3RoID09PSAwKSByZXR1cm47XG4gICAgaWYgKCFhd2FpdCB0aGlzLmF1dGhlbnRpY2F0b3IuZW5zdXJlQXV0aGVudGljYXRlZCgpKSByZXR1cm47XG5cbiAgICBjb25zdCBzdWNjZXNzID0gYXdhaXQgdGhpcy5zeW5jZXIuc2VuZERlbGV0ZWREb2N1bWVudHMoZGVsZXRlZERvY3VtZW50SWRzKTtcbiAgICBpZiAoc3VjY2Vzcykge1xuICAgICAgdGhpcy5kYXRhLnNldHRpbmdzLmRlbGV0ZWREb2N1bWVudElkcyA9IFtdO1xuICAgICAgYXdhaXQgdGhpcy5wZXJzaXN0RGF0YSgpO1xuICAgIH1cbiAgfVxuXG4gIGFzeW5jIG9udW5sb2FkKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGF3YWl0IHRoaXMucGVyc2lzdERhdGEoKTtcbiAgfVxuXG5cbiAgYXN5bmMgcGVyc2lzdERhdGEoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgYXdhaXQgdGhpcy5zYXZlRGF0YSh0aGlzLmRhdGEpO1xuICB9XG59XG5cblxuIiwgImltcG9ydCB7IFRGaWxlLCBWYXVsdCwgTm90aWNlLCBnZXRGcm9udE1hdHRlckluZm8sIEFwcCB9IGZyb20gXCJvYnNpZGlhblwiO1xuaW1wb3J0IHsgS25vd21lbGRTZXR0aW5nU3RvcmUgfSBmcm9tIFwiLi9zZXR0aW5ncy5zdG9yZVwiO1xuXG5cblxuY29uc3QgTUlOX0NPTlRFTlRfTEVOR1RIID0gNTAwO1xuXG5mdW5jdGlvbiBzbGVlcChtczogbnVtYmVyKTogUHJvbWlzZTx2b2lkPiB7XG4gIHJldHVybiBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHNldFRpbWVvdXQocmVzb2x2ZSwgbXMpKTtcbn1cblxuaW50ZXJmYWNlIFBlcnNpc3RlZENhY2hlIHtcbiAgZ2V0KHBhdGg6IHN0cmluZyk6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgc2V0KHBhdGg6IHN0cmluZywgaGFzaDogc3RyaW5nKTogdm9pZDtcbiAgcmVtb3ZlKHBhdGg6IHN0cmluZyk6IHZvaWQ7XG4gIHJlbmFtZShvbGRQYXRoOiBzdHJpbmcsIG5ld1BhdGg6IHN0cmluZyk6IHZvaWQ7XG4gIGdldERvY3VtZW50SWQocGF0aDogc3RyaW5nKTogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICBzZXREb2N1bWVudElkKHBhdGg6IHN0cmluZywgZG9jdW1lbnRJZDogc3RyaW5nKTogdm9pZDtcbiAgc2F2ZSgpOiBQcm9taXNlPHZvaWQ+O1xufVxuXG5lbnVtIFN5bmNEZWNpc2lvbiB7XG4gIFNLSVAsXG4gIFNZTkMsXG4gIEZBSUxFRCxcbn1cblxuaW50ZXJmYWNlIElBdXRoZW50aWNhdG9yIHtcbiAgZW5zdXJlQXV0aGVudGljYXRlZCgpOiBQcm9taXNlPGJvb2xlYW4+O1xuICBnZXRBY2Nlc3NUb2tlbigpOiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjbGFzcyBGaWxlU3luY2VyIHtcbiAgcHJpdmF0ZSB2YXVsdDogVmF1bHQ7XG4gIHByaXZhdGUgY2FjaGVTdG9yZTogUGVyc2lzdGVkQ2FjaGU7XG4gIHByaXZhdGUgc2V0dGluZ3NTdG9yZTogS25vd21lbGRTZXR0aW5nU3RvcmU7XG4gIHByaXZhdGUgYXV0aGVudGljYXRvcjogSUF1dGhlbnRpY2F0b3I7XG4gIHByaXZhdGUgYXBwOiBBcHA7XG5cblxuICBjb25zdHJ1Y3RvcihhcHA6IEFwcCwgdmF1bHQ6IFZhdWx0LCBjYWNoZVN0b3JlOiBQZXJzaXN0ZWRDYWNoZSwgc2V0dGluZ1N0b3JlOiBLbm93bWVsZFNldHRpbmdTdG9yZSwgYXV0aGVudGljYXRvcjogSUF1dGhlbnRpY2F0b3IpIHtcbiAgICB0aGlzLnZhdWx0ID0gdmF1bHQ7XG4gICAgdGhpcy5jYWNoZVN0b3JlID0gY2FjaGVTdG9yZTtcbiAgICB0aGlzLnNldHRpbmdzU3RvcmUgPSBzZXR0aW5nU3RvcmU7XG4gICAgdGhpcy5hdXRoZW50aWNhdG9yID0gYXV0aGVudGljYXRvcjtcbiAgICB0aGlzLmFwcCA9IGFwcDtcbiAgfVxuXG4gIGFzeW5jIHNob3VsZFN5bmNGaWxlKGZpbGU6IFRGaWxlKTogUHJvbWlzZTxTaG91bGRTeW5jRmlsZVJlc3VsdD4ge1xuICAgIGNvbnN0IHNldHRpbmdzID0gdGhpcy5zZXR0aW5nc1N0b3JlLmdldCgpO1xuXG4gICAgY29uc3QgY29udGVudCA9IGF3YWl0IHRoaXMudmF1bHQucmVhZChmaWxlKTtcbiAgICBsZXQgeyBjb250ZW50U3RhcnQgfSA9IGdldEZyb250TWF0dGVySW5mbyhjb250ZW50KTtcbiAgICBjb250ZW50U3RhcnQgPSBjb250ZW50U3RhcnQgPz8gMDtcbiAgICBjb25zdCBjb250ZW50V2l0aG91dEZyb250TWF0dGVyID0gY29udGVudC5zbGljZShjb250ZW50U3RhcnQpO1xuICAgIGNvbnN0IGhhc2ggPSBhd2FpdCBoYXNoQ29udGVudChjb250ZW50KTtcbiAgICBjb25zdCBjYWNoZWRIYXNoID0gdGhpcy5jYWNoZVN0b3JlLmdldChmaWxlLnBhdGgpO1xuXG4gICAgLy8gQ2hlY2sgaWYgaW4gZXhjbHVkZWQgZm9sZGVyc1xuICAgIGlmIChzZXR0aW5ncy5leGNsdWRlZEZvbGRlcnMuc29tZSgoZm9sZGVyOiBzdHJpbmcpID0+IGZpbGUucGF0aC5zdGFydHNXaXRoKGZvbGRlcikpKSB7XG4gICAgICByZXR1cm4geyBzaG91bGRTeW5jOiBmYWxzZSwgcmVhc29uOiBcInBhdGggaXMgaW4gZXhjbHVkZWQgZm9sZGVyc1wiIH07XG4gICAgfVxuXG4gICAgLy8gQ2hlY2sgaWYgc3RhcnRzIHdpdGggdW5kZXJzY29yZVxuICAgIGlmIChmaWxlLnBhdGguc3RhcnRzV2l0aChcIl9cIikpIHtcbiAgICAgIHJldHVybiB7IHNob3VsZFN5bmM6IGZhbHNlLCByZWFzb246IFwicGF0aCBzdGFydHMgd2l0aCB1bmRlcnNjb3JlXCIgfTtcbiAgICB9XG5cbiAgICAvLyBDaGVjayBpZiBtYXJrZG93biBmaWxlXG4gICAgaWYgKCFmaWxlLnBhdGguZW5kc1dpdGgoXCIubWRcIikpIHtcbiAgICAgIHJldHVybiB7IHNob3VsZFN5bmM6IGZhbHNlLCByZWFzb246IFwibm90IGEgbWFya2Rvd24gZmlsZVwiIH07XG4gICAgfVxuXG4gICAgLy8gQ2hlY2sgY29udGVudCBsZW5ndGggaWYgcHJvdmlkZWRcbiAgICBpZiAoY29udGVudFdpdGhvdXRGcm9udE1hdHRlciAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBpZiAoY29udGVudFdpdGhvdXRGcm9udE1hdHRlci50cmltKCkubGVuZ3RoIDwgTUlOX0NPTlRFTlRfTEVOR1RIKSB7XG4gICAgICAgIHJldHVybiB7IHNob3VsZFN5bmM6IGZhbHNlLCByZWFzb246IFwiY29udGVudCB0b28gc2hvcnRcIiB9O1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIENoZWNrIGlmIGNvbnRlbnQgdW5jaGFuZ2VkIGlmIGhhc2hlcyBwcm92aWRlZFxuICAgIGlmIChoYXNoICE9PSB1bmRlZmluZWQgJiYgY2FjaGVkSGFzaCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBpZiAoaGFzaCA9PT0gY2FjaGVkSGFzaCkge1xuICAgICAgICByZXR1cm4geyBzaG91bGRTeW5jOiBmYWxzZSwgcmVhc29uOiBcImNvbnRlbnQgdW5jaGFuZ2VkXCIgfTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICByZXR1cm4geyBzaG91bGRTeW5jOiB0cnVlLCByZWFzb246IFwiZmlsZSBzaG91bGQgYmUgc3luY2VkXCIgfTtcbiAgfVxuXG5cbiAgYXN5bmMgdXBsb2FkRmlsZShmaWxlOiBURmlsZSwgc2Vzc2lvbklkOiBzdHJpbmcpOiBQcm9taXNlPFN5bmNEZWNpc2lvbj4ge1xuICAgIGNvbnN0IHNldHRpbmdzID0gdGhpcy5zZXR0aW5nc1N0b3JlLmdldCgpO1xuXG4gICAgaWYgKCEgYXdhaXQgdGhpcy5hdXRoZW50aWNhdG9yLmVuc3VyZUF1dGhlbnRpY2F0ZWQoKSkge1xuICAgICAgcmV0dXJuIFN5bmNEZWNpc2lvbi5GQUlMRUQ7XG4gICAgfVxuXG4gICAgY29uc3QgY29udGVudCA9IGF3YWl0IHRoaXMudmF1bHQucmVhZChmaWxlKTtcbiAgICBjb25zdCBoYXNoID0gYXdhaXQgaGFzaENvbnRlbnQoY29udGVudCk7XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgZm9ybURhdGEgPSBuZXcgRm9ybURhdGEoKTtcbiAgICAgIGNvbnN0IGJsb2IgPSBuZXcgQmxvYihbY29udGVudF0sIHsgdHlwZTogXCJ0ZXh0L21hcmtkb3duXCIgfSk7XG5cbiAgICAgIGNvbnN0IG1ldGFkYXRhID0geyB2YXVsdF9uYW1lOiB0aGlzLnZhdWx0LmdldE5hbWUoKSB9O1xuICAgICAgZm9ybURhdGEuYXBwZW5kKFwibWV0YWRhdGFcIiwgSlNPTi5zdHJpbmdpZnkobWV0YWRhdGEpKTtcbiAgICAgIGZvcm1EYXRhLmFwcGVuZChcImZpbGVcIiwgYmxvYiwgZmlsZS5uYW1lKTtcbiAgICAgIGZvcm1EYXRhLmFwcGVuZChcImZpbGVfcGF0aFwiLCBmaWxlLnBhdGgpO1xuICAgICAgZm9ybURhdGEuYXBwZW5kKFwibWV0YWRhdGFcIiwgSlNPTi5zdHJpbmdpZnkobWV0YWRhdGEpKTtcblxuICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChgJHtzZXR0aW5ncy5hcGlVcmx9L2ZpbGVzL3VwbG9hZC9maWxlYCwge1xuICAgICAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICAgICAgICBoZWFkZXJzOiB7XG4gICAgICAgICAgQXV0aG9yaXphdGlvbjogYEJlYXJlciAke3RoaXMuYXV0aGVudGljYXRvci5nZXRBY2Nlc3NUb2tlbigpfWAsXG4gICAgICAgICAgXCJYLUtub3dtZWxkLUNvcnJlbGF0aW9uLUlEXCI6IHNlc3Npb25JZCxcbiAgICAgICAgfSxcbiAgICAgICAgYm9keTogZm9ybURhdGEsXG4gICAgICB9KTtcblxuICAgICAgaWYgKCFyZXNwb25zZS5vaykge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEhUVFAgJHtyZXNwb25zZS5zdGF0dXN9YCk7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHJlc3BvbnNlRGF0YSA9IGF3YWl0IHJlc3BvbnNlLmpzb24oKTtcbiAgICAgIHRoaXMuY2FjaGVTdG9yZS5zZXQoZmlsZS5wYXRoLCBoYXNoKTtcbiAgICAgIGlmIChyZXNwb25zZURhdGEuZGV0YWlscy5kb2N1bWVudF9pZCkge1xuICAgICAgICB0aGlzLmNhY2hlU3RvcmUuc2V0RG9jdW1lbnRJZChmaWxlLnBhdGgsIHJlc3BvbnNlRGF0YS5kZXRhaWxzLmRvY3VtZW50X2lkKTtcbiAgICAgIH1cbiAgICAgIGF3YWl0IHRoaXMuY2FjaGVTdG9yZS5zYXZlKCk7XG5cbiAgICAgIHJldHVybiBTeW5jRGVjaXNpb24uU1lOQztcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgbmV3IE5vdGljZShgS25vd21lbGQ6IEZhaWxlZCB0byBzeW5jICR7ZmlsZS5uYW1lfWApO1xuICAgICAgY29uc29sZS5lcnJvcihcIlN5bmMgZXJyb3I6XCIsIGVycm9yKTtcbiAgICAgIHJldHVybiBTeW5jRGVjaXNpb24uRkFJTEVEO1xuICAgIH1cbiAgfVxuXG4gIGFzeW5jIHN5bmNBbGwoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3QgZmlsZXMgPSB0aGlzLnZhdWx0LmdldE1hcmtkb3duRmlsZXMoKTtcbiAgICBjb25zdCBmaWxlc1RvU3luYzogVEZpbGVbXSA9IFtdO1xuICAgIGZvciAoY29uc3QgZmlsZSBvZiBmaWxlcykge1xuICAgICAgY29uc3QgeyBzaG91bGRTeW5jLCByZWFzb24gfSA9IGF3YWl0IHRoaXMuc2hvdWxkU3luY0ZpbGUoZmlsZSk7XG4gICAgICBpZiAoIXNob3VsZFN5bmMpIHtcbiAgICAgICAgY29uc29sZS5sb2coYFNraXBwaW5nIGJlY2F1c2UgZmlsZSBzaG91bGQgbm90IGJlIHN5bmNlZDogJHtyZWFzb259YCwgZmlsZS5wYXRoKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBmaWxlc1RvU3luYy5wdXNoKGZpbGUpO1xuICAgIH1cblxuICAgIGlmIChmaWxlc1RvU3luYy5sZW5ndGggPT09IDApIHtcbiAgICAgIG5ldyBOb3RpY2UoXCJLbm93bWVsZDogTm8gZmlsZXMgdG8gc3luYy5cIik7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGF3YWl0IHRoaXMuc3luY0ZpbGVzKGZpbGVzVG9TeW5jKTtcbiAgfVxuXG4gIGFzeW5jIHN5bmNGaWxlcyhmaWxlczogVEZpbGVbXSk6IFByb21pc2U8dm9pZD4ge1xuICAgIGxldCBzeW5jZWQgPSAwO1xuICAgIGxldCBza2lwcGVkID0gMDtcblxuICAgIGNvbnN0IHNlc3Npb25JZCA9IGF3YWl0IHRoaXMuc3RhcnRTeW5jKCk7XG4gICAgaWYgKCFzZXNzaW9uSWQpIHtcbiAgICAgIG5ldyBOb3RpY2UoXCJLbm93bWVsZDogVW5hYmxlIHRvIHN0YXJ0IHN5bmMgc2Vzc2lvbi5cIik7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgbmV3IE5vdGljZShgS25vd21lbGQ6IFN5bmNpbmcgJHtmaWxlcy5sZW5ndGh9IGZpbGVzLi4uYCk7XG5cblxuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgZmlsZXMubGVuZ3RoOyBpKyspIHtcbiAgICAgIGNvbnN0IGZpbGUgPSBmaWxlc1tpXTtcbiAgICAgIGNvbnN0IHdhc1VwbG9hZGVkID0gYXdhaXQgdGhpcy51cGxvYWRGaWxlKGZpbGUsIHNlc3Npb25JZCk7XG4gICAgICBpZiAod2FzVXBsb2FkZWQgPT09IFN5bmNEZWNpc2lvbi5TWU5DKSBzeW5jZWQrKztcbiAgICAgIGVsc2UgaWYgKHdhc1VwbG9hZGVkID09PSBTeW5jRGVjaXNpb24uU0tJUCkgc2tpcHBlZCsrO1xuICAgICAgZWxzZSB7XG4gICAgICAgIG5ldyBOb3RpY2UoYEtub3dtZWxkOiBTdG9wcGluZyBzeW5jIGR1ZSB0byBlcnJvci5gKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgYXdhaXQgc2xlZXAoMTAwKTsgLy8gYnJpZWYgcGF1c2UgdG8gYXZvaWQgb3ZlcndoZWxtaW5nIHRoZSBzZXJ2ZXJcbiAgICB9XG4gICAgaWYgKHN5bmNlZCkge1xuICAgICAgbmV3IE5vdGljZShgS25vd21lbGQ6IFN5bmNlZCAke3N5bmNlZH0gZmlsZXMsICR7c2tpcHBlZH0gdW5jaGFuZ2VkYCk7XG4gICAgfVxuXG4gICAgYXdhaXQgdGhpcy5maW5pc2hTeW5jKHNlc3Npb25JZCk7XG4gIH1cblxuICBhc3luYyBzeW5jRmlsZShmaWxlOiBURmlsZSk6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IHsgc2hvdWxkU3luYywgcmVhc29uIH0gPSBhd2FpdCB0aGlzLnNob3VsZFN5bmNGaWxlKGZpbGUpO1xuICAgIGlmICghc2hvdWxkU3luYykge1xuICAgICAgbmV3IE5vdGljZShgS25vd21lbGQ6IEZpbGUgbm90IHN5bmNlZDogJHtyZWFzb259YCk7XG4gICAgICBjb25zb2xlLmxvZyhgU2tpcHBpbmcgYmVjYXVzZSBmaWxlIHNob3VsZCBub3QgYmUgc3luY2VkOiAke3JlYXNvbn1gLCBmaWxlLnBhdGgpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBhd2FpdCB0aGlzLnN5bmNGaWxlcyhbZmlsZV0pO1xuICB9XG5cblxuICBhc3luYyBzdGFydFN5bmMoKTogUHJvbWlzZTxzdHJpbmcgfCB2b2lkPiB7XG4gICAgaWYgKCEgYXdhaXQgdGhpcy5hdXRoZW50aWNhdG9yLmVuc3VyZUF1dGhlbnRpY2F0ZWQoKSkge1xuICAgICAgbmV3IE5vdGljZShcIktub3dtZWxkOiBBdXRoZW50aWNhdGlvbiByZXF1aXJlZCB0byBzdGFydCBzeW5jIHNlc3Npb24uXCIpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICB0cnkge1xuICAgICAgY29uc3QgcmVzcCA9IGF3YWl0IGZldGNoKGAke3RoaXMuc2V0dGluZ3NTdG9yZS5nZXQoKS5hcGlVcmx9L2ZpbGVzL3VwbG9hZC9zdGFydGAsIHtcbiAgICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgICAgaGVhZGVyczoge1xuICAgICAgICAgIEF1dGhvcml6YXRpb246IGBCZWFyZXIgJHt0aGlzLmF1dGhlbnRpY2F0b3IuZ2V0QWNjZXNzVG9rZW4oKX1gLFxuICAgICAgICAgIFwiWC1JZGVtcG90ZW5jeS1LZXlcIjogY3J5cHRvLnJhbmRvbVVVSUQoKSxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuICAgICAgaWYgKCFyZXNwLm9rKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcIkF1dGhlbnRpY2F0aW9uIGZhaWxlZFwiKTtcbiAgICAgIH1cblxuICAgICAgY29uc3Qgc2Vzc2lvbklkID0gcmVzcC5oZWFkZXJzLmdldChcIlgtS25vd21lbGQtQ29ycmVsYXRpb24tSURcIik7XG4gICAgICBpZiAoIXNlc3Npb25JZCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJLbm93bWVsZCBFcnJvciBjb3JyZWxhdGlvbiBJRCBtaXNzaW5nIGluIHJlc3BvbnNlXCIpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHNlc3Npb25JZDtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgY29uc29sZS5lcnJvcihcIlN5bmMgc3RhcnQgZXJyb3I6XCIsIGVycm9yKTtcbiAgICAgIG5ldyBOb3RpY2UoXCJLbm93bWVsZDogRmFpbGVkIHRvIHN0YXJ0IHN5bmMgc2Vzc2lvblwiKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gIH1cblxuICBhc3luYyBmaW5pc2hTeW5jKHNlc3Npb25JZDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKCEgYXdhaXQgdGhpcy5hdXRoZW50aWNhdG9yLmVuc3VyZUF1dGhlbnRpY2F0ZWQoKSkge1xuICAgICAgbmV3IE5vdGljZShcIktub3dtZWxkOiBBdXRoZW50aWNhdGlvbiByZXF1aXJlZCB0byBmaW5pc2ggc3luYyBzZXNzaW9uLlwiKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IGZldGNoKGAke3RoaXMuc2V0dGluZ3NTdG9yZS5nZXQoKS5hcGlVcmx9L2ZpbGVzL3VwbG9hZC9jb21wbGV0ZWAsIHtcbiAgICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgICAgaGVhZGVyczoge1xuICAgICAgICAgIEF1dGhvcml6YXRpb246IGBCZWFyZXIgJHt0aGlzLmF1dGhlbnRpY2F0b3IuZ2V0QWNjZXNzVG9rZW4oKX1gLFxuICAgICAgICAgIFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiLFxuICAgICAgICAgIFwiWC1Lbm93bWVsZC1Db3JyZWxhdGlvbi1JRFwiOiBzZXNzaW9uSWQsXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICAgIG5ldyBOb3RpY2UoXCJLbm93bWVsZDogU3luYyBzZXNzaW9uIGNvbXBsZXRlZCBzdWNjZXNzZnVsbHlcIik7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoXCJTeW5jIGZpbmlzaCBlcnJvcjpcIiwgZXJyb3IpO1xuICAgICAgbmV3IE5vdGljZShcIktub3dtZWxkOiBGYWlsZWQgdG8gZmluaXNoIHN5bmMgc2Vzc2lvblwiKTtcbiAgICB9XG4gIH1cblxuXG4gIC8vIFRPRE86IERlbGV0ZSBzaG91bGQgZG8gbW9yZSB0aGFuIGp1c3QgcmVtb3ZlIGZyb20gdGhlIGNhY2hlXG4gIGFzeW5jIGhhbmRsZURlbGV0ZShwYXRoOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICB0aGlzLmNhY2hlU3RvcmUucmVtb3ZlKHBhdGgpO1xuICB9XG5cbiAgLy8gVE9ETzogUmVuYW1lIGNvdWxkIG5vdGlmeSB0aGUgc2VydmVyIG9mIHRoZSBjaGFuZ2VcbiAgYXN5bmMgaGFuZGxlUmVuYW1lKG9sZFBhdGg6IHN0cmluZywgbmV3UGF0aDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgdGhpcy5jYWNoZVN0b3JlLnJlbmFtZShvbGRQYXRoLCBuZXdQYXRoKTtcbiAgfVxuXG4gIGFzeW5jIHNlbmREZWxldGVkRG9jdW1lbnRzKGRvY3VtZW50SWRzOiBzdHJpbmdbXSk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICAgIGlmIChkb2N1bWVudElkcy5sZW5ndGggPT09IDApIHJldHVybiB0cnVlO1xuXG4gICAgY29uc3Qgc2V0dGluZ3MgPSB0aGlzLnNldHRpbmdzU3RvcmUuZ2V0KCk7XG4gICAgaWYgKCFhd2FpdCB0aGlzLmF1dGhlbnRpY2F0b3IuZW5zdXJlQXV0aGVudGljYXRlZCgpKSByZXR1cm4gZmFsc2U7XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChgJHtzZXR0aW5ncy5hcGlVcmx9L2ZpbGVzL2RvY3VtZW50c2AsIHtcbiAgICAgICAgbWV0aG9kOiBcIkRFTEVURVwiLFxuICAgICAgICBoZWFkZXJzOiB7XG4gICAgICAgICAgQXV0aG9yaXphdGlvbjogYEJlYXJlciAke3RoaXMuYXV0aGVudGljYXRvci5nZXRBY2Nlc3NUb2tlbigpfWAsXG4gICAgICAgICAgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIsXG4gICAgICAgIH0sXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZG9jdW1lbnRfaWRzOiBkb2N1bWVudElkcyB9KSxcbiAgICAgIH0pO1xuXG4gICAgICBpZiAoIXJlc3BvbnNlLm9rKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgSFRUUCAke3Jlc3BvbnNlLnN0YXR1c31gKTtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoXCJGYWlsZWQgdG8gc2VuZCBkZWxldGVkIGRvY3VtZW50czpcIiwgZXJyb3IpO1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgfVxufVxuXG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBoYXNoQ29udGVudChjb250ZW50OiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZz4ge1xuICBjb25zdCBlbmNvZGVyID0gbmV3IFRleHRFbmNvZGVyKCk7XG4gIGNvbnN0IGRhdGEgPSBlbmNvZGVyLmVuY29kZShjb250ZW50KTtcbiAgY29uc3QgaGFzaEJ1ZmZlciA9IGF3YWl0IGNyeXB0by5zdWJ0bGUuZGlnZXN0KFwiU0hBLTI1NlwiLCBkYXRhKTtcbiAgY29uc3QgaGFzaEFycmF5ID0gQXJyYXkuZnJvbShuZXcgVWludDhBcnJheShoYXNoQnVmZmVyKSk7XG4gIHJldHVybiBoYXNoQXJyYXkubWFwKChiKSA9PiBiLnRvU3RyaW5nKDE2KS5wYWRTdGFydCgyLCBcIjBcIikpLmpvaW4oXCJcIik7XG59XG5cblxuXG5leHBvcnQgaW50ZXJmYWNlIFNob3VsZFN5bmNGaWxlUmVzdWx0IHtcbiAgc2hvdWxkU3luYzogYm9vbGVhbjtcbiAgcmVhc29uOiBzdHJpbmc7XG59XG5cbiIsICJpbXBvcnQge1xuICBBcHAsIFBsdWdpblNldHRpbmdUYWIsIFNldHRpbmcsXG59IGZyb20gXCJvYnNpZGlhblwiO1xuaW1wb3J0IHR5cGUgS25vd21lbGRQbHVnaW4gZnJvbSBcIi4vbWFpblwiO1xuaW1wb3J0IHsgS25vd21lbGRTZXR0aW5nU3RvcmUgfSBmcm9tIFwiLi9zZXR0aW5ncy5zdG9yZVwiO1xuXG5pbnRlcmZhY2UgSUF1dGhlbnRpY2F0b3Ige1xuICBjb25uZWN0KGlzQ29ubmVjdGVkOiBib29sZWFuKTogUHJvbWlzZTx2b2lkPjtcbiAgZGlzY29ubmVjdCgpOiBQcm9taXNlPHZvaWQ+O1xufVxuXG5leHBvcnQgY2xhc3MgS25vd21lbGRTZXR0aW5nVGFiIGV4dGVuZHMgUGx1Z2luU2V0dGluZ1RhYiB7XG4gIHBsdWdpbjogS25vd21lbGRQbHVnaW47XG4gIHNldHRpbmdzU3RvcmU6IEtub3dtZWxkU2V0dGluZ1N0b3JlO1xuICBhdXRoZW50aWNhdG9yOiBJQXV0aGVudGljYXRvcjtcblxuICBjb25zdHJ1Y3RvcihhcHA6IEFwcCwgcGx1Z2luOiBLbm93bWVsZFBsdWdpbiwgc2V0dGluZ3NTdG9yZTogS25vd21lbGRTZXR0aW5nU3RvcmUsIGF1dGhlbnRpY2F0b3I6IElBdXRoZW50aWNhdG9yKSB7XG4gICAgc3VwZXIoYXBwLCBwbHVnaW4pO1xuICAgIHRoaXMucGx1Z2luID0gcGx1Z2luO1xuICAgIHRoaXMuc2V0dGluZ3NTdG9yZSA9IHNldHRpbmdzU3RvcmU7XG4gICAgdGhpcy5hdXRoZW50aWNhdG9yID0gYXV0aGVudGljYXRvcjtcbiAgfVxuXG4gIGRpc3BsYXkoKTogdm9pZCB7XG4gICAgY29uc3QgeyBjb250YWluZXJFbCB9ID0gdGhpcztcbiAgICBjb250YWluZXJFbC5lbXB0eSgpO1xuICAgIGNvbnN0IHNldHRpbmdzID0gdGhpcy5zZXR0aW5nc1N0b3JlLmdldCgpO1xuICAgIGNvbnN0IGlzQ29ubmVjdGVkID0gc2V0dGluZ3MuYXV0aERldGFpbHMgPyB0cnVlIDogZmFsc2U7XG5cbiAgICAvLyBDb25uZWN0L1JlY29ubmVjdCBidXR0b25cblxuICAgIG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxuICAgICAgLnNldE5hbWUoXCJDb25uZWN0IHRvIEtub3dtZWxkXCIpXG4gICAgICAuc2V0RGVzYyhcIlRoaXMgcmVnaXN0ZXJzIHlvdXIgT2JzaWRpYW4gd2l0aCBLbm93bWVsZCBmb3Igc3luY1wiKVxuICAgICAgLmFkZEJ1dHRvbigoYnRuKSA9PlxuICAgICAgICBidG4uc2V0QnV0dG9uVGV4dChpc0Nvbm5lY3RlZCA/IFwiUmVjb25uZWN0XCIgOiBcIkNvbm5lY3RcIikub25DbGljayhhc3luYyAoKSA9PiB7XG4gICAgICAgICAgYXdhaXQgdGhpcy5hdXRoZW50aWNhdG9yLmNvbm5lY3QoaXNDb25uZWN0ZWQpO1xuICAgICAgICAgIHRoaXMuZGlzcGxheSgpOyAvLyBSZWZyZXNoIHRoZSBzZXR0aW5ncyBVSVxuICAgICAgICB9KVxuICAgICAgKTtcblxuXG4gICAgLy8gRGlzY29ubmVjdCBidXR0b24gKG9ubHkgc2hvd24gd2hlbiBjb25uZWN0ZWQpXG4gICAgaWYgKGlzQ29ubmVjdGVkKSB7XG4gICAgICBuZXcgU2V0dGluZyhjb250YWluZXJFbClcbiAgICAgICAgLnNldE5hbWUoXCJEaXNjb25uZWN0IGZyb20gS25vd21lbGRcIilcbiAgICAgICAgLnNldERlc2MoXCJSZW1vdmUgdGhlIGNvbm5lY3Rpb24gdG8gS25vd21lbGRcIilcbiAgICAgICAgLmFkZEJ1dHRvbigoYnRuKSA9PlxuICAgICAgICAgIGJ0blxuICAgICAgICAgICAgLnNldEJ1dHRvblRleHQoXCJEaXNjb25uZWN0XCIpXG4gICAgICAgICAgICAuc2V0V2FybmluZygpXG4gICAgICAgICAgICAub25DbGljayhhc3luYyAoKSA9PiB7XG4gICAgICAgICAgICAgIGF3YWl0IHRoaXMuYXV0aGVudGljYXRvci5kaXNjb25uZWN0KCk7XG4gICAgICAgICAgICAgIHRoaXMuZGlzcGxheSgpOyAvLyBSZWZyZXNoIHRoZSBzZXR0aW5ncyBVSVxuICAgICAgICAgICAgfSlcbiAgICAgICAgKTtcbiAgICB9XG5cbiAgICAvLyBSZWFsLXRpbWUgc3luYyBpbnRlcnZhbCBzbGlkZXJcbiAgICBuZXcgU2V0dGluZyhjb250YWluZXJFbClcbiAgICAgIC5zZXROYW1lKFwiUmVhbC10aW1lIHN5bmMgaW50ZXJ2YWxcIilcbiAgICAgIC5zZXREZXNjKGBTeW5jIGZpbGVzIGF1dG9tYXRpY2FsbHkgYWZ0ZXIgdGhpcyBtYW55IG1pbnV0ZXMgb2YgaW5hY3Rpdml0eSAoJHtNYXRoLnJvdW5kKHRoaXMuc2V0dGluZ3NTdG9yZS5nZXQoKS5yZWFsdGltZVN5bmNJbnRlcnZhbCAvIDYwKX0gbWluKWApXG4gICAgICAuYWRkU2xpZGVyKChzbGlkZXIpID0+XG4gICAgICAgIHNsaWRlclxuICAgICAgICAgIC5zZXRMaW1pdHMoMiwgMTAsIDEpXG4gICAgICAgICAgLnNldFZhbHVlKE1hdGgucm91bmQodGhpcy5zZXR0aW5nc1N0b3JlLmdldCgpLnJlYWx0aW1lU3luY0ludGVydmFsIC8gNjApKVxuICAgICAgICAgIC5zZXREeW5hbWljVG9vbHRpcCgpXG4gICAgICAgICAgLm9uQ2hhbmdlKGFzeW5jICh2YWx1ZSkgPT4ge1xuICAgICAgICAgICAgY29uc3Qgc2Vjb25kcyA9IE1hdGgubWF4KHZhbHVlLCAyKSAqIDYwOyAvLyBFbmZvcmNlIG1pbmltdW0gb2YgMiBtaW51dGVzXG4gICAgICAgICAgICB0aGlzLnNldHRpbmdzU3RvcmUuc2V0KHsgcmVhbHRpbWVTeW5jSW50ZXJ2YWw6IHNlY29uZHMgfSk7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5wZXJzaXN0RGF0YSgpO1xuICAgICAgICAgICAgdGhpcy5kaXNwbGF5KCk7IC8vIFJlZnJlc2ggdG8gdXBkYXRlIGRlc2NyaXB0aW9uXG4gICAgICAgICAgfSlcbiAgICAgICk7XG5cbiAgICBuZXcgU2V0dGluZyhjb250YWluZXJFbClcbiAgICAgIC5zZXROYW1lKFwiRXhjbHVkZWQgZm9sZGVyc1wiKVxuICAgICAgLnNldERlc2MoXCJGb2xkZXJzIHRvIGV4Y2x1ZGUgZnJvbSBzeW5jaW5nLCBzZXBhcmF0ZWQgYnkgY29tbWFzXCIpXG4gICAgICAuYWRkVGV4dCgodGV4dCkgPT4ge1xuICAgICAgICB0ZXh0XG4gICAgICAgICAgLnNldFBsYWNlaG9sZGVyKFwiZS5nLiBQcml2YXRlLFRlbXBsYXRlc1wiKVxuICAgICAgICAgIC5zZXRWYWx1ZSh0aGlzLnNldHRpbmdzU3RvcmUuZ2V0KCkuZXhjbHVkZWRGb2xkZXJzLmpvaW4oXCIsXCIpKVxuICAgICAgICAgIC5vbkNoYW5nZShhc3luYyAodmFsdWUpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IGZvbGRlcnMgPSB2YWx1ZS5zcGxpdChcIixcIikubWFwKChmb2xkZXIpID0+IGZvbGRlci50cmltKCkpO1xuICAgICAgICAgICAgdGhpcy5zZXR0aW5nc1N0b3JlLnNldCh7IGV4Y2x1ZGVkRm9sZGVyczogZm9sZGVycyB9KTtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnBlcnNpc3REYXRhKCk7XG4gICAgICAgICAgfSk7XG4gICAgICB9KTtcbiAgfVxufVxuXG5cbiIsICJleHBvcnQgaW50ZXJmYWNlIEF1dGhEZXRhaWxzIHtcbiAgICB0b2tlbklEOiBzdHJpbmc7XG4gICAgYWNjZXNzVG9rZW46IHN0cmluZztcbiAgICBhY2Nlc3NUb2tlbkV4cGlyZXNBdDogbnVtYmVyO1xuICAgIHJlZnJlc2hUb2tlbjogc3RyaW5nO1xuICAgIHJlZnJlc2hUb2tlbkV4cGlyZXNBdDogbnVtYmVyO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEtub3dtZWxkU2V0dGluZ3Mge1xuICAgIGFwaVVybDogc3RyaW5nO1xuICAgIGRhc2hib2FyZFVybD86IHN0cmluZztcbiAgICBhdXRoRGV0YWlscz86IEF1dGhEZXRhaWxzO1xuICAgIGV4Y2x1ZGVkRm9sZGVyczogc3RyaW5nW107XG4gICAgcmVhbHRpbWVTeW5jSW50ZXJ2YWw6IG51bWJlcjsgIC8vIHNlY29uZHMsIGRlZmF1bHQgMTIwICgyIG1pbilcbiAgICBkZWxldGVkRG9jdW1lbnRJZHM6IHN0cmluZ1tdOyAgIC8vIGRvY3VtZW50IFVVSURzIHBlbmRpbmcgZGVsZXRpb25cbn1cblxuZXhwb3J0IGludGVyZmFjZSBLbm93bWVsZFNldHRpbmdTdG9yZSB7XG4gICAgZ2V0KCk6IEtub3dtZWxkU2V0dGluZ3M7XG4gICAgc2V0KHNldHRpbmc6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4gfCBudW1iZXIgfCBzdHJpbmdbXSB8IEF1dGhEZXRhaWxzIHwgbnVsbD4pOiB2b2lkO1xufVxuXG5leHBvcnQgY29uc3QgREVGQVVMVF9TRVRUSU5HUzogS25vd21lbGRTZXR0aW5ncyA9IHtcbiAgICBhcGlVcmw6IHByb2Nlc3MuZW52Lk5PREVfRU5WID09PSBcInByb2R1Y3Rpb25cIlxuICAgICAgICA/IFwiaHR0cHM6Ly9hcGkua25vd21lbGQuaW8vdjFcIlxuICAgICAgICA6IFwiaHR0cDovL2xvY2FsaG9zdDo4MDAwL3YxXCIsXG4gICAgZGFzaGJvYXJkVXJsOiBwcm9jZXNzLmVudi5OT0RFX0VOViA9PT0gXCJwcm9kdWN0aW9uXCJcbiAgICAgICAgPyBcImh0dHBzOi8vZGFzaGJvYXJkLmtub3dtZWxkLmlvXCJcbiAgICAgICAgOiBcImh0dHA6Ly9sb2NhbGhvc3Q6ODAwMFwiLFxuICAgIGF1dGhEZXRhaWxzOiB1bmRlZmluZWQsXG4gICAgZXhjbHVkZWRGb2xkZXJzOiBbXSxcbiAgICByZWFsdGltZVN5bmNJbnRlcnZhbDogMTIwLFxuICAgIGRlbGV0ZWREb2N1bWVudElkczogW10sXG59OyIsICJpbXBvcnQgeyBOb3RpY2UgfSBmcm9tIFwib2JzaWRpYW5cIjtcblxuaW1wb3J0IHsgS25vd21lbGRTZXR0aW5nU3RvcmUgfSBmcm9tIFwiLi9zZXR0aW5ncy5zdG9yZVwiO1xuXG5cblxuZXhwb3J0IGludGVyZmFjZSBQZXJzaXN0ZWRDYWNoZSB7XG4gICAgZ2V0KHBhdGg6IHN0cmluZyk6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICBzZXQocGF0aDogc3RyaW5nLCBoYXNoOiBzdHJpbmcpOiB2b2lkO1xuICAgIHNhdmUoKTogUHJvbWlzZTx2b2lkPjtcbn1cbmV4cG9ydCBjbGFzcyBBdXRoZW50aWNhdG9yIHtcbiAgICBwcml2YXRlIHNldHRpbmdzU3RvcmU6IEtub3dtZWxkU2V0dGluZ1N0b3JlO1xuICAgIHByaXZhdGUgY2FjaGVTdG9yZTogUGVyc2lzdGVkQ2FjaGU7XG4gICAgY29uc3RydWN0b3Ioc2V0dGluZ3NTdG9yZTogS25vd21lbGRTZXR0aW5nU3RvcmUsIGNhY2hlU3RvcmU6IFBlcnNpc3RlZENhY2hlKSB7XG4gICAgICAgIHRoaXMuc2V0dGluZ3NTdG9yZSA9IHNldHRpbmdzU3RvcmU7XG4gICAgICAgIHRoaXMuY2FjaGVTdG9yZSA9IGNhY2hlU3RvcmU7XG4gICAgfVxuICAgIHN0YXRpYyBnZXRBdXRoSGVhZGVyKGFjY2Vzc1Rva2VuOiBzdHJpbmcpOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+IHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIEF1dGhvcml6YXRpb246IGBCZWFyZXIgJHthY2Nlc3NUb2tlbn1gLFxuICAgICAgICB9O1xuICAgIH1cblxuICAgIGFzeW5jIGF1dGhlbnRpY2F0ZSgpOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgICAgICAgY29uc3Qgc2V0dGluZ3MgPSB0aGlzLnNldHRpbmdzU3RvcmUuZ2V0KCk7XG4gICAgICAgIGlmICghc2V0dGluZ3MuYXV0aERldGFpbHMpIHtcbiAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgfVxuXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCBmb3JtRGF0YSA9IG5ldyBGb3JtRGF0YSgpO1xuICAgICAgICAgICAgZm9ybURhdGEuYXBwZW5kKFwicmVmcmVzaF90b2tlblwiLCBzZXR0aW5ncy5hdXRoRGV0YWlscy5yZWZyZXNoVG9rZW4pO1xuICAgICAgICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChgJHtzZXR0aW5ncy5hcGlVcmx9L2F1dGgvdG9rZW4vcmVmcmVzaGAsIHtcbiAgICAgICAgICAgICAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICAgICAgICAgICAgICAgIGJvZHk6IGZvcm1EYXRhLFxuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIGlmICghcmVzcG9uc2Uub2spIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEhUVFAgJHtyZXNwb25zZS5zdGF0dXN9YCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnN0IGRhdGEgPSBhd2FpdCByZXNwb25zZS5qc29uKCk7XG4gICAgICAgICAgICBjb25zdCB7IHRva2VuX2lkLCBhY2Nlc3NfdG9rZW4sIHJlZnJlc2hfdG9rZW4sIGFjY2Vzc190b2tlbl9leHBpcmVzX2F0LCByZWZyZXNoX3Rva2VuX2V4cGlyZXNfYXQgfSA9IGRhdGE7XG5cbiAgICAgICAgICAgIHRoaXMucGVyc2lzdEF1dGhEZXRhaWxzKFxuICAgICAgICAgICAgICAgIHRva2VuX2lkLFxuICAgICAgICAgICAgICAgIGFjY2Vzc190b2tlbixcbiAgICAgICAgICAgICAgICBhY2Nlc3NfdG9rZW5fZXhwaXJlc19hdCxcbiAgICAgICAgICAgICAgICByZWZyZXNoX3Rva2VuLFxuICAgICAgICAgICAgICAgIHJlZnJlc2hfdG9rZW5fZXhwaXJlc19hdFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIGF3YWl0XG4gICAgICAgICAgICAgICAgdGhpcy5jYWNoZVN0b3JlLnNhdmUoKTtcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgY29uc29sZS5lcnJvcihcIkF1dGhlbnRpY2F0aW9uIGVycm9yOlwiLCBlcnJvcik7XG4gICAgICAgICAgICBuZXcgTm90aWNlKFwiS25vd21lbGQ6IEF1dGhlbnRpY2F0aW9uIGZhaWxlZC4gUGxlYXNlIHJlY29ubmVjdCB5b3VyIGRldmljZSBpbiB0aGUgc2V0dGluZ3MuXCIpO1xuICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgcGVyc2lzdEF1dGhEZXRhaWxzKHRva2VuSUQ6IHN0cmluZywgYWNjZXNzVG9rZW46IHN0cmluZywgYWNjZXNzVG9rZW5FeHBpcmVzQXQ6IG51bWJlciwgcmVmcmVzaFRva2VuOiBzdHJpbmcsIHJlZnJlc2hUb2tlbkV4cGlyZXNBdDogbnVtYmVyKTogdm9pZCB7XG4gICAgICAgIHRoaXMuc2V0dGluZ3NTdG9yZS5zZXQoe1xuICAgICAgICAgICAgYXV0aERldGFpbHM6IHtcbiAgICAgICAgICAgICAgICB0b2tlbklELFxuICAgICAgICAgICAgICAgIGFjY2Vzc1Rva2VuLFxuICAgICAgICAgICAgICAgIGFjY2Vzc1Rva2VuRXhwaXJlc0F0OiBhY2Nlc3NUb2tlbkV4cGlyZXNBdCAqIDEwMDAsXG4gICAgICAgICAgICAgICAgcmVmcmVzaFRva2VuLFxuICAgICAgICAgICAgICAgIHJlZnJlc2hUb2tlbkV4cGlyZXNBdDogcmVmcmVzaFRva2VuRXhwaXJlc0F0ICogMTAwMCxcbiAgICAgICAgICAgIH0sXG4gICAgICAgIH0pO1xuICAgICAgICB0aGlzLmNhY2hlU3RvcmUuc2F2ZSgpO1xuICAgIH1cblxuICAgIGFzeW5jIGNvbm5lY3QoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgICAgIGNvbnN0IHNldHRpbmdzID0gdGhpcy5zZXR0aW5nc1N0b3JlLmdldCgpO1xuICAgICAgICB3aW5kb3cub3BlbihcbiAgICAgICAgICAgIGAke3NldHRpbmdzLmRhc2hib2FyZFVybH0vZGFzaGJvYXJkL2Nvbm5lY3Q/Y29ubmVjdG9yPW9ic2lkaWFuYCxcbiAgICAgICAgKTtcbiAgICB9XG5cbiAgICBpc0Nvbm5lY3RlZCgpOiBib29sZWFuIHtcbiAgICAgICAgY29uc3Qgc2V0dGluZ3MgPSB0aGlzLnNldHRpbmdzU3RvcmUuZ2V0KCk7XG4gICAgICAgIHJldHVybiAhIXNldHRpbmdzLmF1dGhEZXRhaWxzO1xuICAgIH1cblxuICAgIGlzQXV0aGVudGljYXRlZCgpOiBib29sZWFuIHtcbiAgICAgICAgaWYgKCF0aGlzLmlzQ29ubmVjdGVkKCkpIHJldHVybiBmYWxzZTtcbiAgICAgICAgY29uc3Qgc2V0dGluZ3MgPSB0aGlzLnNldHRpbmdzU3RvcmUuZ2V0KCk7XG4gICAgICAgIGNvbnN0IGJ1ZmZlck1zID0gNjAgKiAxMDAwOyAgLy8gMW1pbiBlYXJseSByZWZyZXNoXG4gICAgICAgIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gICAgICAgIHJldHVybiBzZXR0aW5ncy5hdXRoRGV0YWlscyEuYWNjZXNzVG9rZW5FeHBpcmVzQXQgLSBidWZmZXJNcyA+IG5vdztcbiAgICB9XG5cbiAgICBhc3luYyBlbnN1cmVBdXRoZW50aWNhdGVkKCk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICAgICAgICBpZiAodGhpcy5pc0F1dGhlbnRpY2F0ZWQoKSkgcmV0dXJuIHRydWU7XG4gICAgICAgIHJldHVybiBhd2FpdCB0aGlzLmF1dGhlbnRpY2F0ZSgpO1xuICAgIH1cblxuICAgIGFzeW5jIGRpc2Nvbm5lY3QoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgICAgIGNvbnN0IHNldHRpbmdzID0gdGhpcy5zZXR0aW5nc1N0b3JlLmdldCgpO1xuICAgICAgICBpZiAoIXNldHRpbmdzLmF1dGhEZXRhaWxzKSByZXR1cm47XG4gICAgICAgIGlmICghYXdhaXQgdGhpcy5lbnN1cmVBdXRoZW50aWNhdGVkKCkpIHJldHVybjtcbiAgICAgICAgY29uc3QgZm9ybURhdGEgPSBuZXcgRm9ybURhdGEoKTtcbiAgICAgICAgZm9ybURhdGEuYXBwZW5kKFwidG9rZW5faWRcIiwgc2V0dGluZ3MuYXV0aERldGFpbHMudG9rZW5JRCk7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKGAke3NldHRpbmdzLmFwaVVybH0vYXV0aC9yZXZva2VgLCB7XG4gICAgICAgICAgICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgICAgICAgICAgICBoZWFkZXJzOiB7XG4gICAgICAgICAgICAgICAgICAgIEF1dGhvcml6YXRpb246IGBCZWFyZXIgJHt0aGlzLmdldEFjY2Vzc1Rva2VuKCl9YCxcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIGJvZHk6IGZvcm1EYXRhLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICBpZiAoIXJlc3BvbnNlLm9rKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBIVFRQICR7cmVzcG9uc2Uuc3RhdHVzfWApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdGhpcy5zZXR0aW5nc1N0b3JlLnNldCh7IGF1dGhEZXRhaWxzOiBudWxsIH0pO1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5jYWNoZVN0b3JlLnNhdmUoKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoXCJEaXNjb25uZWN0IGVycm9yOlwiLCBlcnJvcik7XG4gICAgICAgICAgICBuZXcgTm90aWNlKFwiS25vd21lbGQ6IEZhaWxlZCB0byBkaXNjb25uZWN0IGZyb20gS25vd21lbGQuXCIpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgZ2V0QWNjZXNzVG9rZW4oKTogc3RyaW5nIHtcbiAgICAgICAgY29uc3Qgc2V0dGluZ3MgPSB0aGlzLnNldHRpbmdzU3RvcmUuZ2V0KCk7XG4gICAgICAgIHJldHVybiBzZXR0aW5ncy5hdXRoRGV0YWlscz8uYWNjZXNzVG9rZW4gfHwgXCJcIjtcbiAgICB9XG5cbiAgICBhc3luYyBmaW5pc2hQYWlyaW5nKHBhaXJpbmdDb2RlOiBzdHJpbmcsIGNvcnJlbGF0aW9uSWQ6IHN0cmluZyk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICAgICAgICBjb25zdCBzZXR0aW5ncyA9IHRoaXMuc2V0dGluZ3NTdG9yZS5nZXQoKTtcbiAgICAgICAgY29uc3QgZm9ybURhdGEgPSBuZXcgRm9ybURhdGEoKTtcbiAgICAgICAgZm9ybURhdGEuYXBwZW5kKFwicGFpcmluZ19jb2RlXCIsIHBhaXJpbmdDb2RlKTtcbiAgICAgICAgY29uc3QgcmVzcCA9IGF3YWl0IGZldGNoKGAke3NldHRpbmdzLmFwaVVybH0vYXV0aC90b2tlbi9wYWlyYCwge1xuICAgICAgICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgICAgICAgIGJvZHk6IGZvcm1EYXRhLFxuICAgICAgICAgICAgaGVhZGVyczoge1xuICAgICAgICAgICAgICAgIFwiWC1Lbm93bWVsZC1Db3JyZWxhdGlvbi1JRFwiOiBjb3JyZWxhdGlvbklkLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgfSk7XG4gICAgICAgIGlmICghcmVzcC5vaykge1xuICAgICAgICAgICAgbmV3IE5vdGljZShcIktub3dtZWxkOiBGYWlsZWQgdG8gY29ubmVjdCBkZXZpY2UuXCIpO1xuICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGRhdGEgPSBhd2FpdCByZXNwLmpzb24oKTtcbiAgICAgICAgaWYgKGRhdGEuYWNjZXNzX3Rva2VuICYmIGRhdGEucmVmcmVzaF90b2tlbikge1xuICAgICAgICAgICAgLy8gUHl0aG9uIHNlbmRzIHRpbWVzdGFtcCBzZWNvbmRzLCBjb252ZXJ0IHRvIG1zXG4gICAgICAgICAgICB0aGlzLnBlcnNpc3RBdXRoRGV0YWlscyhcbiAgICAgICAgICAgICAgICBkYXRhLnRva2VuX2lkLFxuICAgICAgICAgICAgICAgIGRhdGEuYWNjZXNzX3Rva2VuLFxuICAgICAgICAgICAgICAgIGRhdGEuYWNjZXNzX3Rva2VuX2V4cGlyZXNfYXQsXG4gICAgICAgICAgICAgICAgZGF0YS5yZWZyZXNoX3Rva2VuLFxuICAgICAgICAgICAgICAgIGRhdGEucmVmcmVzaF90b2tlbl9leHBpcmVzX2F0XG4gICAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbn0iXSwKICAibWFwcGluZ3MiOiAiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLElBQUFBLG1CQUFxRDs7O0FDQXJELHNCQUE4RDtBQUs5RCxJQUFNLHFCQUFxQjtBQUUzQixTQUFTLE1BQU0sSUFBMkI7QUFDeEMsU0FBTyxJQUFJLFFBQVEsYUFBVyxXQUFXLFNBQVMsRUFBRSxDQUFDO0FBQ3ZEO0FBdUJPLElBQU0sYUFBTixNQUFpQjtBQUFBLEVBUXRCLFlBQVksS0FBVSxPQUFjLFlBQTRCLGNBQW9DLGVBQStCO0FBQ2pJLFNBQUssUUFBUTtBQUNiLFNBQUssYUFBYTtBQUNsQixTQUFLLGdCQUFnQjtBQUNyQixTQUFLLGdCQUFnQjtBQUNyQixTQUFLLE1BQU07QUFBQSxFQUNiO0FBQUEsRUFFQSxNQUFNLGVBQWUsTUFBNEM7QUFDL0QsVUFBTSxXQUFXLEtBQUssY0FBYyxJQUFJO0FBRXhDLFVBQU0sVUFBVSxNQUFNLEtBQUssTUFBTSxLQUFLLElBQUk7QUFDMUMsUUFBSSxFQUFFLGFBQWEsUUFBSSxvQ0FBbUIsT0FBTztBQUNqRCxtQkFBZSxzQ0FBZ0I7QUFDL0Is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UUFBaUIsQ0FBQztBQUN4QixpQkFBVyxRQUFRLGFBQWE7QUFDOUIsY0FBTSxPQUFPLEtBQUssSUFBSSxNQUFNLHNCQUFzQixJQUFJO0FBQ3RELFlBQUksZ0JBQWdCLHdCQUFPO0FBQ3pCLGdCQUFNLEtBQUssSUFBSTtBQUFBLFFBQ2pCO0FBQUEsTUFDRjtBQUVBLFVBQUksTUFBTSxXQUFXO0FBQUc7QUFHeEIsWUFBTSxLQUFLLE9BQU8sVUFBVSxLQUFLO0FBQUEsSUFFbkMsVUFBRTtBQUNBLFdBQUssVUFBVTtBQUFBLElBQ2pCO0FBQUEsRUFDRjtBQUFBLEVBRUEsTUFBYyxvQkFBbUM7QUFDL0MsVUFBTSxxQkFBcUIsS0FBSyxLQUFLLFNBQVM7QUFDOUMsUUFBSSxtQkFBbUIsV0FBVztBQUFHO0FBQ3JDLFFBQUksQ0FBQyxNQUFNLEtBQUssY0FBYyxvQkFBb0I7QUFBRztBQUVyRCxVQUFNLFVBQVUsTUFBTSxLQUFLLE9BQU8scUJBQXFCLGtCQUFrQjtBQUN6RSxRQUFJLFNBQVM7QUFDWCxXQUFLLEtBQUssU0FBUyxxQkFBcUIsQ0FBQztBQUN6QyxZQUFNLEtBQUssWUFBWTtBQUFBLElBQ3pCO0FBQUEsRUFDRjtBQUFBLEVBRUEsTUFBTSxXQUEwQjtBQUM5QixVQUFNLEtBQUssWUFBWTtBQUFBLEVBQ3pCO0FBQUEsRUFHQSxNQUFNLGNBQTZCO0FBQ2pDLFVBQU0sS0FBSyxTQUFTLEtBQUssSUFBSTtBQUFBLEVBQy9CO0FBQ0Y7IiwKICAibmFtZXMiOiBbImltcG9ydF9vYnNpZGlhbiIsICJpbXBvcnRfb2JzaWRpYW4iLCAiaW1wb3J0X29ic2lkaWFuIl0KfQo=

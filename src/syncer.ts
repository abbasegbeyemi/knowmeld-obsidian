import { TFile, Vault, Notice, getFrontMatterInfo } from "obsidian";
import { KnowmeldSettingStore } from "./settings.store";


const MIN_CONTENT_LENGTH = 500;

export interface PersistedCache {
  get(path: string): string | undefined;
  set(path: string, hash: string): void;
  remove(path: string): void;
  rename(oldPath: string, newPath: string): void;
  save(): Promise<void>;
}

enum SyncDecision {
  SKIP,
  SYNC,
  FAILED,
}

export class FileSyncer {
  private vault: Vault;
  private cacheStore: PersistedCache;
  private settingsStore: KnowmeldSettingStore;


  constructor(vault: Vault, cacheStore: PersistedCache, settingStore: KnowmeldSettingStore) {
    this.vault = vault;
    this.cacheStore = cacheStore;
    this.settingsStore = settingStore;
  }


  async uploadFile(file: TFile, uploadSessionId: string, correlationId: string): Promise<SyncDecision> {
    const settings = this.settingsStore.get();
    if (settings.excludedFolders.some(folder => file.path.startsWith(folder))) {
      console.log("Skipping because path is in excluded folders:", file.path);
      return SyncDecision.SKIP;
    }
    if (file.path.startsWith("_")) {
      console.log("Skipping because path starts with underscore:", file.path);
      return SyncDecision.SKIP;
    }
    if (!file.path.endsWith(".md")) {
      console.log("Skipping because not a markdown file:", file.path);
      return SyncDecision.SKIP;
    }

    if (!settings.accessToken) {
      new Notice("Knowmeld: Your device has not been connected. Please connect in the settings.");
      return SyncDecision.FAILED;
    }

    const content = await this.vault.read(file);
    let { contentStart } = getFrontMatterInfo(content);
    contentStart = contentStart ?? 0;
    const contentWithoutFrontMatter = content.slice(contentStart);

    if (contentWithoutFrontMatter.trim().length < MIN_CONTENT_LENGTH) {
      console.log("Skipping because content too short:", file.path);
      return SyncDecision.SKIP;
    }

    const hash = await hashContent(content);
    const cachedHash = this.cacheStore.get(file.path);

    if (cachedHash === hash) {
      console.log("Skipping because content unchanged:", file.path);
      return SyncDecision.SKIP;
    }

    try {
      const formData = new FormData();
      const blob = new Blob([content], { type: "text/markdown" });
      formData.append("file", blob, file.name);
      formData.append("file_path", file.path);
      formData.append("vault_path", this.vault.getRoot().path);
      formData.append("upload_session_id", uploadSessionId);
      formData.append("correlation_id", correlationId);

      const response = await fetch(`${settings.apiUrl}/upload`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${settings.accessToken}`,
        },
        body: formData,
      });

      if (!response.ok) {
        if (response.status === 401) {
          const authenticated = await this.authenticate();
          if (authenticated) {
            return this.uploadFile(file, uploadSessionId, correlationId);
          } else {
            throw new Error("Authentication failed");
          }
        } else {
          throw new Error(`HTTP ${response.status}`);
        }
      }

      this.cacheStore.set(file.path, hash);
      await this.cacheStore.save();

      return SyncDecision.SYNC;
    } catch (error) {
      new Notice(`Knowmeld: Failed to sync ${file.name}`);
      console.error("Sync error:", error);
      return SyncDecision.FAILED;
    }
  }

  async syncAll(): Promise<void> {
    const files = this.vault.getMarkdownFiles();
    let synced = 0;
    let skipped = 0;

    const { upload_session_id, correlation_id } = await this.startSync() || {};
    if (!upload_session_id || !correlation_id) {
      new Notice("Knowmeld: Unable to start sync session.");
      return;
    }

    for (const file of files) {
      const wasUploaded = await this.uploadFile(file, upload_session_id, correlation_id);
      if (wasUploaded === SyncDecision.SYNC) synced++;
      else if (wasUploaded === SyncDecision.SKIP) skipped++;
      else {
        new Notice(`Knowmeld: Stopping sync due to error.`);
        return;
      }
      sleep(100); // brief pause to avoid overwhelming the server
    }

    new Notice(`Knowmeld: Synced ${synced} files, ${skipped} unchanged`);
    await this.finishSync(upload_session_id);
  }

  async syncFile(file: TFile): Promise<void> {
    const { upload_session_id, correlation_id } = await this.startSync() || {};
    if (!upload_session_id || !correlation_id) {
      new Notice("Knowmeld: Unable to start sync session.");
      return;
    }

    const wasUploaded = await this.uploadFile(file, upload_session_id, correlation_id);
    if (wasUploaded === SyncDecision.SYNC) {
      new Notice(`Knowmeld: Synced ${file.name}`);
    } else if (wasUploaded === SyncDecision.SKIP) {
      new Notice(`Knowmeld: No changes to sync for ${file.name}`);
    }

    await this.finishSync(upload_session_id);
  }

  async authenticate(): Promise<boolean> {
    const settings = this.settingsStore.get();
    if (!settings.accessToken) {
      new Notice("Knowmeld: Your device has not been connected. Please connect in the settings.");
      return false;
    }

    try {
      const formData = new FormData();
      formData.append("refresh_token", settings.refreshToken!);
      const response = await fetch(`${settings.apiUrl}/auth/device-tokens/refresh`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${settings.accessToken}`,
        },
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      const { access_token, refresh_token } = data;

      if (access_token) {
        this.settingsStore.set({ accessToken: access_token, refreshToken: refresh_token });
        this.cacheStore.save();
      }

      return true;
    } catch (error) {
      new Notice(`Knowmeld: Authentication failed`);
      console.error("Authentication error:", error);
      return false;
    }
  }

  async startSync(): Promise<Record<string, string> | void> {
    try {
      const resp = await fetch(`${this.settingsStore.get().apiUrl}/upload/start`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.settingsStore.get().accessToken}`,
          "Idempotency-Key": crypto.randomUUID(),
        },
      });
      if (!resp.ok) {
        if (!this.settingsStore.get().accessToken) {
          new Notice("Knowmeld: Your device has not been connected. Please connect in the settings.");
          return;
        }
        if (resp.status === 401) {
          const authenticated = await this.authenticate();
          if (authenticated) {
            return this.startSync();
          } else {
            throw new Error("Authentication failed");
          }
        }
      }
      const { upload_session_id, correlation_id } = await resp.json();
      return { upload_session_id, correlation_id };

    } catch (error) {
      console.error("Sync start error:", error);
      new Notice("Knowmeld: Failed to start sync session");
      return;
    }
  }

  async finishSync(uploadSessionId: string): Promise<void> {
    try {
      const resp = await fetch(`${this.settingsStore.get().apiUrl}/upload/complete?upload_session_id=${uploadSessionId}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.settingsStore.get().accessToken}`,
          "Content-Type": "application/json",
        },
      });
      if (!resp.ok) {
        if (resp.status === 401) {
          const authenticated = await this.authenticate();
          if (authenticated) {
            return this.finishSync(uploadSessionId);
          } else {
            throw new Error("Authentication failed");
          }
        }
      }
    } catch (error) {
      console.error("Sync finish error:", error);
      new Notice("Knowmeld: Failed to finish sync session");
    }
  }


  // TODO: Delete should do more than just remove from the cache
  async handleDelete(path: string): Promise<void> {
    this.cacheStore.remove(path);
  }

  // TODO: Rename could notify the server of the change
  async handleRename(oldPath: string, newPath: string): Promise<void> {
    this.cacheStore.rename(oldPath, newPath);
  }
}


export async function hashContent(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
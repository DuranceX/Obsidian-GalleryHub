import { App, TAbstractFile, TFile, TFolder, normalizePath } from "obsidian";
import { ASSETS_DIR, GalleryStore } from "./store";
import {
  ASSET_HASH_INDEX_VERSION,
  GalleryItem,
  typeFromExt,
} from "./types";
import { classifyTarget } from "./resource";
import {
  SystemFileObservation,
  currentSystemFilePlatform,
  readSystemFileObservation,
  sameSystemFileId,
  systemFileObservationKey,
  withSystemFileObservation,
} from "./system-file-id";

const HASH_BATCH_SIZE = 5;
const STAT_YIELD_EVERY = 20;

export interface AssetPathRepair {
  id: string;
  oldPath: string;
  newPath: string;
  /** 候选文件当前指纹；读取失败时为 null，应用后等待下次补全。 */
  hash?: string | null;
  systemFileObservation?: SystemFileObservation | null;
}

export interface MissingAssetEntry {
  id: string;
  path: string;
}

export interface UnownedAssetCandidate {
  path: string;
  hash: string | null;
  systemFileObservation: SystemFileObservation | null;
}

export interface AssetIndexReport {
  managed: number;
  healthy: number;
  missing: number;
  candidates: number;
  hashesAdded: number;
  repairs: AssetPathRepair[];
  ambiguous: number;
  unresolved: number;
  unresolvedItems: MissingAssetEntry[];
  unmatchedCandidates: UnownedAssetCandidate[];
}

export type AssetIndexProgress = (
  current: number,
  total: number,
  fileName: string
) => void;

/** 对导入时已经读取的二进制数据计算稳定的 SHA-256。 */
export async function hashAssetBuffer(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function isManagedAsset(item: GalleryItem): item is GalleryItem & { path: string } {
  return !!item.path && item.path.startsWith(`${ASSETS_DIR}/`);
}

function remapPath(
  value: string,
  oldPath: string,
  newPath: string,
  folder: boolean
): string | null {
  if (value === oldPath) return newPath;
  if (folder && value.startsWith(`${oldPath}/`)) {
    return `${newPath}${value.slice(oldPath.length)}`;
  }
  return null;
}

function assetRelativeFolder(path: string): string | null {
  if (path === ASSETS_DIR) return "";
  const prefix = `${ASSETS_DIR}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 20));
}

/**
 * assets 文件索引：隐藏哈希迁移、离线改名修复与运行期路径同步。
 * 链接/笔记不参与哈希；库内 link 只在收到 Obsidian rename 时更新引用。
 */
export class AssetIndex {
  private migrationRun = 0;

  constructor(private app: App, private store: GalleryStore) {}

  stop(): void {
    this.migrationRun++;
  }

  /** 启动后后台刷新当前平台 File ID；存量哈希仍只迁移一次。 */
  startBackgroundIndexing(): void {
    if (!this.store.loaded || this.store.readOnly) return;
    const run = ++this.migrationRun;
    void this.runBackgroundIndexing(run);
  }

  private async runBackgroundIndexing(run: number): Promise<void> {
    // 避免与布局恢复、视图初始化争抢首屏资源。
    await new Promise((resolve) => window.setTimeout(resolve, 800));
    if (run !== this.migrationRun) return;
    await this.refreshKnownSystemFileIds(run);
    if (
      run !== this.migrationRun ||
      this.store.getAssetHashIndexVersion() >= ASSET_HASH_INDEX_VERSION
    )
      return;
    await this.migrateLegacyHashes(run);
  }

  private async migrateLegacyHashes(run: number): Promise<void> {
    const pending = this.store
      .getItems()
      .filter(isManagedAsset)
      .filter((item) => !item.hash);
    let batch: Array<{ id: string; patch: Partial<GalleryItem> }> = [];
    for (const item of pending) {
      if (run !== this.migrationRun) return;
      const file = this.app.vault.getAbstractFileByPath(normalizePath(item.path));
      if (file instanceof TFile) {
        try {
          const hash = await this.hashFile(file);
          if (run !== this.migrationRun) return;
          batch.push({ id: item.id, patch: { hash } });
        } catch {
          // 单个文件读取失败不阻断整次迁移；手动检查时可再次尝试。
        }
      }
      if (batch.length >= HASH_BATCH_SIZE) {
        if (run !== this.migrationRun) return;
        this.store.updateItems(batch, { touchModifiedAt: false, notify: false });
        batch = [];
      }
      await yieldToUi();
    }
    if (run !== this.migrationRun) return;
    if (batch.length) {
      this.store.updateItems(batch, { touchModifiedAt: false, notify: false });
    }
    this.store.setAssetHashIndexVersion(ASSET_HASH_INDEX_VERSION);
  }

  /** 通过仍有效的 path 覆写当前平台 File ID，不读取文件内容。 */
  private async refreshKnownSystemFileIds(run: number): Promise<void> {
    const platform = currentSystemFilePlatform();
    if (!platform) return;
    let batch: Array<{ id: string; patch: Partial<GalleryItem> }> = [];
    let visited = 0;
    for (const item of this.store.getItems().filter(isManagedAsset)) {
      if (run !== this.migrationRun) return;
      const file = this.app.vault.getAbstractFileByPath(normalizePath(item.path));
      if (!(file instanceof TFile)) continue;
      const observation = await readSystemFileObservation(this.app, file.path);
      if (
        observation &&
        !sameSystemFileId(
          item.systemFileIds?.[platform],
          observation.value
        )
      ) {
        batch.push({
          id: item.id,
          patch: {
            systemFileIds: withSystemFileObservation(
              item.systemFileIds,
              observation
            ),
          },
        });
      }
      if (batch.length >= HASH_BATCH_SIZE) {
        if (run !== this.migrationRun) return;
        this.store.updateItems(batch, {
          touchModifiedAt: false,
          notify: false,
        });
        batch = [];
      }
      visited++;
      if (visited % STAT_YIELD_EVERY === 0) await yieldToUi();
    }
    if (run !== this.migrationRun) return;
    if (batch.length) {
      this.store.updateItems(batch, {
        touchModifiedAt: false,
        notify: false,
      });
    }
  }

  private async hashFile(file: TFile): Promise<string> {
    const buffer = await this.app.vault.adapter.readBinary(file.path);
    return hashAssetBuffer(buffer);
  }

  /** Obsidian 运行期间的文件/文件夹 rename：同步实体 path 与库内 link url。 */
  handleVaultRename(file: TAbstractFile, oldRawPath: string): void {
    if (!this.store.loaded || this.store.readOnly) return;
    const oldPath = normalizePath(oldRawPath);
    const newPath = normalizePath(file.path);
    const isFolder = file instanceof TFolder;
    const oldFolder = isFolder ? assetRelativeFolder(oldPath) : null;
    const newFolder = isFolder ? assetRelativeFolder(newPath) : null;
    const patches: Array<{ id: string; patch: Partial<GalleryItem> }> = [];

    for (const item of this.store.getItems()) {
      const patch: Partial<GalleryItem> = {};
      if (item.path) {
        const mapped = remapPath(item.path, oldPath, newPath, isFolder);
        if (mapped) patch.path = mapped;
      }
      if (
        item.type === "link" &&
        item.url &&
        classifyTarget(item.url) === "vault"
      ) {
        const mapped = remapPath(item.url, oldPath, newPath, isFolder);
        if (mapped) patch.url = mapped;
      }
      if (
        isFolder &&
        oldFolder !== null &&
        newFolder !== null &&
        !item.path &&
        item.folder
      ) {
        const mapped = remapPath(item.folder, oldFolder, newFolder, true);
        if (mapped !== null) patch.folder = mapped || undefined;
      }
      if (Object.keys(patch).length) patches.push({ id: item.id, patch });
    }

    this.store.updateItems(patches);
  }

  /** 手动检查：补齐仍存在文件的哈希，并为离线改名生成唯一匹配修复计划。 */
  async scanForRepairs(onProgress?: AssetIndexProgress): Promise<AssetIndexReport> {
    // 手动检查覆盖后台迁移，避免同一批文件被重复读取和写入。
    this.migrationRun++;
    const managed = this.store.getItems().filter(isManagedAsset);
    const files = this.listAssetFiles();
    const actualPaths = new Set(files.map((file) => normalizePath(file.path)));
    const registeredPaths = new Set(managed.map((item) => normalizePath(item.path)));
    const healthy = managed.filter((item) => actualPaths.has(normalizePath(item.path)));
    const missing = managed.filter((item) => !actualPaths.has(normalizePath(item.path)));
    const candidates = files.filter(
      (file) => !registeredPaths.has(normalizePath(file.path))
    );
    const healthyByPath = new Map(
      healthy.map((item) => [normalizePath(item.path), item])
    );

    const healthyWithoutHash = healthy.filter((item) => !item.hash);
    const total =
      files.length +
      healthyWithoutHash.length +
      (missing.length ? candidates.length : 0);
    let current = 0;
    let hashesAdded = 0;
    const metadataPatches = new Map<string, Partial<GalleryItem>>();
    const mergeMetadataPatch = (
      id: string,
      patch: Partial<GalleryItem>
    ): void => {
      metadataPatches.set(id, { ...metadataPatches.get(id), ...patch });
    };

    const platform = currentSystemFilePlatform();
    const observationByPath = new Map<string, SystemFileObservation>();
    let observationsRead = 0;
    for (const file of files) {
      const observation = await readSystemFileObservation(this.app, file.path);
      const path = normalizePath(file.path);
      if (observation) observationByPath.set(path, observation);
      const item = healthyByPath.get(path);
      if (
        item &&
        platform &&
        observation &&
        !sameSystemFileId(
          item.systemFileIds?.[platform],
          observation.value
        )
      ) {
        mergeMetadataPatch(item.id, {
          systemFileIds: withSystemFileObservation(
            item.systemFileIds,
            observation
          ),
        });
      }
      current++;
      onProgress?.(current, total, file.name);
      observationsRead++;
      if (observationsRead % STAT_YIELD_EVERY === 0) await yieldToUi();
    }

    for (const item of healthyWithoutHash) {
      const file = this.app.vault.getAbstractFileByPath(normalizePath(item.path));
      if (file instanceof TFile) {
        try {
          const hash = await this.hashFile(file);
          mergeMetadataPatch(item.id, { hash });
          hashesAdded++;
        } catch {
          // 报告中仍视为正常路径，但没有文件指纹。
        }
      }
      current++;
      onProgress?.(current, total, file instanceof TFile ? file.name : item.fileName ?? "");
      await yieldToUi();
    }
    if (metadataPatches.size) {
      this.store.updateItems(
        [...metadataPatches].map(([id, patch]) => ({ id, patch })),
        { touchModifiedAt: false, notify: false }
      );
    }

    const candidateHashByPath = new Map<string, string>();
    if (missing.length) {
      for (const file of candidates) {
        try {
          const hash = await this.hashFile(file);
          candidateHashByPath.set(normalizePath(file.path), hash);
        } catch {
          // 无法读取的候选文件不参与自动匹配。
        }
        current++;
        onProgress?.(current, total, file.name);
        await yieldToUi();
      }
    }

    const repairs: AssetPathRepair[] = [];
    const repairedIds = new Set<string>();
    const repairedPaths = new Set<string>();

    // 第一优先级：只比较当前平台保存的 volumeId + fileId。
    if (platform) {
      const missingBySystemFileId = new Map<string, GalleryItem[]>();
      for (const item of missing) {
        const value = item.systemFileIds?.[platform];
        if (!value) continue;
        const key = systemFileObservationKey({ platform, value });
        const list = missingBySystemFileId.get(key) ?? [];
        list.push(item);
        missingBySystemFileId.set(key, list);
      }
      const candidatesBySystemFileId = new Map<string, TFile[]>();
      for (const file of candidates) {
        const observation = observationByPath.get(normalizePath(file.path));
        if (!observation) continue;
        const key = systemFileObservationKey(observation);
        const list = candidatesBySystemFileId.get(key) ?? [];
        list.push(file);
        candidatesBySystemFileId.set(key, list);
      }
      for (const [key, items] of missingBySystemFileId) {
        const matched = candidatesBySystemFileId.get(key) ?? [];
        if (items.length !== 1 || matched.length !== 1) continue;
        const file = matched[0];
        const path = normalizePath(file.path);
        repairs.push({
          id: items[0].id,
          oldPath: items[0].path!,
          newPath: path,
          hash: candidateHashByPath.get(path) ?? items[0].hash ?? null,
          systemFileObservation: observationByPath.get(path) ?? null,
        });
        repairedIds.add(items[0].id);
        repairedPaths.add(path);
      }
    }

    // 第二优先级：对 File ID 未命中的剩余条目做唯一 Hash 匹配。
    const remainingMissing = missing.filter((item) => !repairedIds.has(item.id));
    const remainingCandidates = candidates.filter(
      (file) => !repairedPaths.has(normalizePath(file.path))
    );
    const missingByHash = new Map<string, GalleryItem[]>();
    for (const item of remainingMissing.filter((item) => !!item.hash)) {
      const list = missingByHash.get(item.hash!) ?? [];
      list.push(item);
      missingByHash.set(item.hash!, list);
    }
    const candidatesByHash = new Map<string, TFile[]>();
    for (const file of remainingCandidates) {
      const hash = candidateHashByPath.get(normalizePath(file.path));
      if (!hash) continue;
      const list = candidatesByHash.get(hash) ?? [];
      list.push(file);
      candidatesByHash.set(hash, list);
    }

    let ambiguous = 0;
    for (const [hash, items] of missingByHash) {
      const matched = candidatesByHash.get(hash) ?? [];
      if (items.length === 1 && matched.length === 1) {
        const path = normalizePath(matched[0].path);
        repairs.push({
          id: items[0].id,
          oldPath: items[0].path!,
          newPath: path,
          hash,
          systemFileObservation: observationByPath.get(path) ?? null,
        });
        repairedIds.add(items[0].id);
        repairedPaths.add(path);
      } else if (matched.length) {
        ambiguous += items.length;
      }
    }

    const unresolvedItems = missing
      .filter((item) => !repairedIds.has(item.id))
      .map((item) => ({ id: item.id, path: item.path }));
    const unmatchedCandidates = candidates
      .filter((file) => !repairedPaths.has(normalizePath(file.path)))
      .map((file) => ({
        path: normalizePath(file.path),
        hash: candidateHashByPath.get(normalizePath(file.path)) ?? null,
        systemFileObservation:
          observationByPath.get(normalizePath(file.path)) ?? null,
      }));

    // 手动全量检查也完成了存量哈希迁移，后续启动无需再次补全。
    this.store.setAssetHashIndexVersion(ASSET_HASH_INDEX_VERSION);

    return {
      managed: managed.length,
      healthy: healthy.length,
      missing: missing.length,
      candidates: candidates.length,
      hashesAdded,
      repairs,
      ambiguous,
      unresolved: unresolvedItems.length,
      unresolvedItems,
      unmatchedCandidates,
    };
  }

  applyRepairs(repairs: AssetPathRepair[]): number {
    const patchById = new Map<string, Partial<GalleryItem>>();
    const pathMap = new Map<string, string>();
    const usedNewPaths = new Set<string>();
    let repaired = 0;
    for (const repair of repairs) {
      const item = this.store.getItem(repair.id);
      const newPath = normalizePath(repair.newPath);
      const file = this.app.vault.getAbstractFileByPath(
        newPath
      );
      const alreadyRegistered = this.store
        .getItems()
        .some(
          (other) =>
            other.id !== repair.id &&
            !!other.path &&
            normalizePath(other.path) === newPath
        );
      if (
        item?.path !== repair.oldPath ||
        !(file instanceof TFile) ||
        usedNewPaths.has(newPath) ||
        alreadyRegistered
      )
        continue;
      const nextType = typeFromExt(file.extension);
      if (!nextType) continue;
      const patch: Partial<GalleryItem> = {
        path: newPath,
        type: nextType,
      };
      if (repair.hash !== undefined) {
        patch.hash = repair.hash;
        if (repair.hash !== item.hash) {
          patch.w = undefined;
          patch.h = undefined;
        }
      }
      if (repair.systemFileObservation) {
        patch.systemFileIds = withSystemFileObservation(
          item.systemFileIds,
          repair.systemFileObservation
        );
      }
      patchById.set(item.id, patch);
      pathMap.set(normalizePath(repair.oldPath), newPath);
      usedNewPaths.add(newPath);
      repaired++;
    }

    // 同一个受管资源若还被 link 卡片引用，也随已确认的修复一起更新。
    for (const item of this.store.getItems()) {
      if (
        item.type !== "link" ||
        !item.url ||
        classifyTarget(item.url) !== "vault"
      )
        continue;
      const mapped = pathMap.get(normalizePath(item.url));
      if (mapped) {
        patchById.set(item.id, {
          ...patchById.get(item.id),
          url: mapped,
        });
      }
    }

    this.store.updateItems(
      [...patchById].map(([id, patch]) => ({ id, patch }))
    );
    return repaired;
  }

  private listAssetFiles(): TFile[] {
    const root = this.app.vault.getAbstractFileByPath(normalizePath(ASSETS_DIR));
    if (!(root instanceof TFolder)) return [];
    const files: TFile[] = [];
    const visit = (folder: TFolder) => {
      for (const child of folder.children) {
        if (child instanceof TFolder) visit(child);
        else if (child instanceof TFile && typeFromExt(child.extension)) files.push(child);
      }
    };
    visit(root);
    return files;
  }
}

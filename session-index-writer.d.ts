type Backend = typeof import('./db');
type Cache = typeof import('./session-cache');
type EffectName = 'upsertCachedSessions' | 'deleteCachedSession' | 'deleteCachedFolder'
  | 'touchCachedModified' | 'setFolderMeta' | 'setName' | 'replaceSessionMetrics'
  | 'deleteSearchFolder' | 'deleteSearchSession' | 'upsertSearchEntries';
type Effect = { [Name in EffectName]: { name: Name; args: Parameters<Backend[Name]> } }[EffectName];
type SearchEntry = { id: string; type: string; folder?: string; title: string; body?: string };
type ScanResult = {
  folder: string; projectPath: string | null; indexMtimeMs: number;
  sessions: Array<{ sessionId: string; folder: string; [key: string]: unknown }>;
  partial?: boolean; toDelete?: string[];
};
type Project = { projectPath: string; sessions: Array<{ sessionId: string; [key: string]: unknown }>; [key: string]: unknown };
type ArchiveGroup = { projectPath: string; folderKey?: string | null };
type ArchiveResult = { ok?: true; error?: string; disabled?: string[]; failed?: Array<{ name: string; error: string }> };
type ArchiveRuntime = {
  seedProjects(): string[];
  scan(projectPath: string): unknown[];
  realpath(file: string): string;
  setEnabled(file: string, enabled: boolean, options: { projectRoot: string }): { ok: boolean; error?: string };
  mergeProjects(projects: Project[]): Project[];
  activeSessions: Map<string, unknown>;
  notify(): void;
  now(): string;
};
type Logger = { warn(...args: unknown[]): void };
type OfferRuntime = { notify(): void };

export interface SessionIndexWriter {
  initializeCache(ctx: Omit<Parameters<Cache['init']>[0], 'db' | 'writer'>): void;
  setSetting(key: string, value: unknown): Promise<void>;
  deleteSetting(key: string): Promise<void>;
  patchGlobal(fields: Record<string, unknown>): Promise<void>;
  toggleStar(sessionId: string): Promise<number>;
  setArchived(sessionId: string, archived: boolean | number): Promise<void>;
  renameSession(sessionId: string, name: string | null): Promise<{ name: string | null }>;
  deleteCachedSession(sessionId: string): Promise<void>;
  deleteSearchSession(sessionId: string): Promise<void>;
  deleteCachedFolder(folder: string): Promise<void>;
  deleteSearchFolder(folder: string): Promise<void>;
  deleteSearchType(type: string): Promise<void>;
  applySearchFileBatch(type: string, deletes: string[], entries: SearchEntry[]): Promise<void>;
  setCachedEntrypoints(pairs: Array<{ sessionId: string; entrypoint: string }>): Promise<void>;
  setCachedCustomTitles(pairs: Array<{ sessionId: string; customTitle: string; fileMtime?: string | null }>): Promise<void>;
  setCachedContinuationIndex(sessionId: string, index: string): Promise<void>;
  setInitialScanComplete(): Promise<void>;
  refreshFolder(folder: string, opts?: { files?: Set<string> | null }): Promise<void>;
  dropFolderRows(folder: string, opts?: { search?: boolean }): Promise<void>;
  releaseLiveSession(sessionId: string): Promise<boolean>;
  writeScannedFolder(result: ScanResult | null, unverifiedLocalFolder?: string | null): Promise<number>;
  writeScannedFolderPartial(result: ScanResult | null): Promise<number>;
  applyProjectsWorkerEffects(result: { effects: Effect[]; keptLiveRows: Array<[string, string]> }): Promise<void>;
  buildProjectsFromCache(showArchived: boolean): Promise<Project[]>;
  archiveProjectFolders(groups: ArchiveGroup[], opts: { disableSchedules?: string[] }, deps: ArchiveRuntime): Promise<ArchiveResult>;
  applyAndPersistArchived(projects: Project[], showArchived: boolean): Promise<Project[]>;
  clearArchivedEntry(alias: string | null, projectPath: string): Promise<boolean>;
  reenableOfferedSchedules(projectPath: string, folderKey: string | null, deps: OfferRuntime): Promise<unknown>;
  dismissReenableOffer(projectPath: string, folderKey: string | null, deps: OfferRuntime): Promise<unknown>;
  hideProject(entry: string, kind: 'archive' | 'delete'): Promise<void>;
  unhideProject(entry: string, alias: string | null, projectPath: string): Promise<void>;
  revealAddedProject(projectPath: string): Promise<void>;
  cleanupWorktree(normalizedPath: string, log: Logger): Promise<number>;
  dropRemoteFolder(folderKey: string): Promise<void>;
  remapProjectTranscripts(args: { folder: string; folderPath: string; oldPath: string; newPath: string }): Promise<void>;
  scheduleRegistry(seed: () => string[]): {
    list(): Promise<string[]>; add(projectPath: string): Promise<void>; remove(projectPath: string): Promise<void>;
  };
  createWhatsNew(options: Omit<Parameters<typeof import('./changelog').createWhatsNew>[0], 'getSetting' | 'setSetting'>): {
    startup(): Promise<unknown>; dismissed(): Promise<void>; forMenu(): unknown;
  };
  closeDb(): Promise<void>;
}

export function createSessionIndexWriter(backend?: Backend, cache?: Cache): SessionIndexWriter;

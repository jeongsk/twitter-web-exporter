import { queueThreads } from '@/threads/queue';
import { isThreadsPage } from '@/threads/model';
import { queueYoutube } from '@/youtube/queue';
import { isYoutubePage } from '@/youtube/model';
import { queueThread } from '@/backup/thread-queue';
import { BackupConnectionError } from '@/backup/connection-errors';
import { BackupDatabase, type BackupJob } from '@/backup/queue';
import { isBackupRecord, renderNote } from '@/backup/format';
import { acceptsModule, type BackupConfig, type BackupStatus } from '@/backup/types';
import {
  ObsidianRestClient,
  normalizeEndpoint,
  normalizeFolder,
  validateApiKey,
  permissionOrigin,
  DEFAULT_ENDPOINT,
  DEFAULT_FOLDER,
  type ApiSettings,
} from '@/backup/rest';
import { saveApiSettings } from '@/backup/settings-handler';
import {
  AUTO_INTERVALS,
  AUTO_SOURCES,
  AUTO_TIMEOUT,
  autoStep,
  knownFromJobs,
  mergeKnown,
  normalizeInterval,
  type AutoPlatform,
  type AutoRunResult,
  type AutoSession,
  type AutoStopReason,
} from '@/backup/auto-collect';
import { isXPage } from './protocol';

const db = new BackupDatabase();
const ALARM = 'twe-vault-backup-retry';
const AUTO_ALARM = 'twe-auto-collect';
const AUTO_WATCHDOG = 'twe-auto-collect-watchdog';
const AUTO_CONFIG_KEY = 'autoCollectConfig';
const AUTO_KNOWN_KEY = 'autoCollectKnown';
const AUTO_RESULT_KEY = 'autoCollectLastRun';
const AUTO_RUN_KEY = 'autoCollectRun';
const OFFLINE_NOTIFICATION = 'twe-obsidian-offline';
const OFFLINE_CODES = new Set(['NETWORK', 'TLS_OR_NETWORK', 'TIMEOUT']);
const OFFLINE_NOTIFY_AFTER = 60 * 60 * 1000;
const PROBE_INTERVAL = 5 * 60 * 1000;
const CONFIG_KEY = 'vaultBackupConfig';
const READY = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
let running: Promise<void> | undefined;
let threadIngest: Promise<unknown> = Promise.resolve();
function enqueueThreads(bundle: unknown) {
  const result = threadIngest.then(async () => queueThreads(db, bundle, await config()));
  threadIngest = result.catch(() => {});
  return result.then((reply) => {
    void drain().catch(reportError);
    return reply;
  });
}
/** Shares the Threads ingest chain so writes from every platform's list are serialized. */
function enqueueYoutube(videos: unknown) {
  const result = threadIngest.then(async () => queueYoutube(db, videos, await config()));
  threadIngest = result.catch(() => {});
  return result.then((reply) => {
    void drain().catch(reportError);
    return reply;
  });
}
function enqueueThread(bundle: unknown) {
  const result = threadIngest.then(async () => queueThread(db, bundle, await config()));
  threadIngest = result.catch(() => {});
  return result.then((reply) => {
    void drain().catch(reportError);
    return reply;
  });
}
interface StoredConfig {
  vaultBackupConfig?: Partial<BackupConfig>;
  vaultBackupApi?: ApiSettings;
}
interface BackupMeta {
  lastBackupError?: string;
  lastBackupSuccess?: number;
  lastBackupPath?: string;
  backupPluginVersion?: string;
  disconnectedSince?: number;
  disconnectNotified?: boolean;
  lastProbeAt?: number;
}
async function config(): Promise<BackupConfig> {
  await READY;
  const value = (await chrome.storage.local.get<StoredConfig>(CONFIG_KEY))[CONFIG_KEY];
  return {
    enabled: value?.enabled === true,
    threadsEnabled: value?.threadsEnabled === true,
    youtubeEnabled: value?.youtubeEnabled === true,
    scope: value?.scope === 'tweets' ? 'tweets' : 'bookmarks',
    destinationId: typeof value?.destinationId === 'string' ? value.destinationId : '',
  };
}
async function apiSettings(): Promise<ApiSettings | null> {
  await READY;
  const stored = (await chrome.storage.local.get<StoredConfig>('vaultBackupApi')).vaultBackupApi;
  if (!stored) return null;
  return {
    endpoint: normalizeEndpoint(stored.endpoint),
    folder: normalizeFolder(stored.folder),
    apiKey: validateApiKey(stored.apiKey),
  };
}
async function apiClient() {
  const settings = await apiSettings();
  if (!settings) throw new Error('Obsidian Local REST API 연결을 먼저 설정하세요.');
  if (!(await chrome.permissions.contains({ origins: [permissionOrigin(settings.endpoint)] })))
    throw new Error('로컬 API 접근 권한이 없습니다. 연결 확인을 다시 실행하세요.');
  return new ObsidianRestClient(settings);
}
async function status(): Promise<BackupStatus> {
  const cfg = await config();
  const api = await apiSettings();
  const meta = await chrome.storage.local.get<BackupMeta>([
    'lastBackupError',
    'lastBackupSuccess',
    'lastBackupPath',
    'backupPluginVersion',
    'disconnectedSince',
  ]);
  const auto = await autoStatus();
  return {
    ok: true,
    config: cfg,
    pending: await db.jobs.where('[target+state]').equals([cfg.destinationId, 'pending']).count(),
    done: await db.jobs.where('[target+state]').equals([cfg.destinationId, 'done']).count(),
    failed: await db.jobs
      .where('[target+state]')
      .equals([cfg.destinationId, 'pending'])
      .filter((job) => job.attempts > 0)
      .count(),
    otherDestination: await db.jobs
      .where('state')
      .equals('pending')
      .filter((job) => job.target !== cfg.destinationId)
      .count(),
    lastError: typeof meta.lastBackupError === 'string' ? meta.lastBackupError : '',
    lastSuccess: typeof meta.lastBackupSuccess === 'number' ? meta.lastBackupSuccess : 0,
    lastPath: typeof meta.lastBackupPath === 'string' ? meta.lastBackupPath : '',
    api: {
      endpoint: api?.endpoint ?? DEFAULT_ENDPOINT,
      folder: api?.folder ?? DEFAULT_FOLDER,
      hasApiKey: !!api?.apiKey,
      pluginVersion: typeof meta.backupPluginVersion === 'string' ? meta.backupPluginVersion : '',
    },
    disconnectedSince: typeof meta.disconnectedSince === 'number' ? meta.disconnectedSince : 0,
    autoCollect: auto,
  };
}
async function reportError(error: unknown) {
  await chrome.storage.local.set({
    lastBackupError: error instanceof Error ? error.message : '백업 오류',
  });
}
async function enqueue(module: unknown, records: unknown) {
  const cfg = await config();
  if (!cfg.enabled) return { ok: true, accepted: 0, paused: true };
  if (typeof module !== 'string' || !acceptsModule(cfg.scope, module))
    return { ok: true, accepted: 0 };
  if (!cfg.destinationId) throw new Error('백업 저장 위치를 먼저 연결하세요.');
  if (!Array.isArray(records) || records.length > 5 || !records.every(isBackupRecord))
    throw new Error('백업 데이터 형식이나 크기가 올바르지 않습니다.');
  const notes = await Promise.all(records.map((record) => renderNote(record)));
  await db.transaction('rw', db.jobs, async () => {
    let pending = await db.jobs.where('state').equals('pending').count();
    for (const note of notes) {
      const key = `${cfg.destinationId}:${note.id}:${note.hash}`;
      const previous = await db.jobs.get(key);
      if (previous) {
        if (!previous.modules.includes(module))
          await db.jobs.update(key, { modules: [...previous.modules, module] });
        continue;
      }
      if (pending >= 5000)
        throw new Error('대기열이 5,000개에 도달했습니다. 처리 후 기존 데이터를 다시 추가하세요.');
      await db.jobs.add({
        ...note,
        key,
        target: cfg.destinationId,
        state: 'pending',
        modules: [module],
        due: 0,
        attempts: 0,
        error: '',
        createdAt: Date.now(),
      });
      pending++;
    }
  });
  void drain().catch(reportError);
  return { ok: true, accepted: records.length };
}
async function flush() {
  const started = Date.now();
  while (Date.now() - started < 20000) {
    const cfg = await config();
    if (!cfg.enabled || !cfg.destinationId) return;
    const job = await db.jobs
      .where('[target+state]')
      .equals([cfg.destinationId, 'pending'])
      .filter(
        (j) =>
          j.due <= Date.now() &&
          (j.platform === 'threads'
            ? cfg.threadsEnabled === true
            : j.platform === 'youtube'
              ? cfg.youtubeEnabled === true
              : j.modules.some((m) => acceptsModule(cfg.scope, m))),
      )
      .first();
    if (!job) return;
    try {
      const result = await (await apiClient()).write(job);
      await db.jobs.update(job.key, {
        state: 'done',
        markdown: undefined,
        error: '',
        path: result.path,
        completedAt: Date.now(),
      });
      await chrome.storage.local.set({
        lastBackupSuccess: Date.now(),
        lastBackupPath: result.path,
        lastBackupError: '',
      });
      await markOnline();
    } catch (error) {
      await markConnection(error);
      await db.jobs.update(job.key, {
        attempts: job.attempts + 1,
        due: Date.now() + Math.min(30, 2 ** Math.min(job.attempts, 5)) * 60000,
        error: error instanceof Error ? error.message : '백업 실패',
      });
      await reportError(error);
      return;
    }
  }
}
async function markOnline() {
  const meta = await chrome.storage.local.get<BackupMeta>(['disconnectedSince']);
  if (meta.disconnectedSince === undefined) return;
  await chrome.storage.local.remove(['disconnectedSince', 'disconnectNotified']);
  await chrome.notifications.clear(OFFLINE_NOTIFICATION);
}
/** Only an unreachable server counts as "Obsidian is off"; auth or file errors do not. */
async function markOffline(error: unknown) {
  if (!(error instanceof BackupConnectionError) || !OFFLINE_CODES.has(error.code)) return;
  const meta = await chrome.storage.local.get<BackupMeta>([
    'disconnectedSince',
    'disconnectNotified',
  ]);
  const since = meta.disconnectedSince ?? Date.now();
  if (meta.disconnectedSince === undefined)
    await chrome.storage.local.set({ disconnectedSince: since });
  if (meta.disconnectNotified || Date.now() - since < OFFLINE_NOTIFY_AFTER) return;
  const pending = await db.jobs.where('state').equals('pending').count();
  await chrome.notifications.create(OFFLINE_NOTIFICATION, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon32.png'),
    title: 'Obsidian 백업 연결 끊김',
    message: `${Math.floor((Date.now() - since) / 60000)}분째 Obsidian Local REST API에 연결할 수 없습니다. 대기 중인 ${pending}개 항목은 보관 중이며 연결되면 자동으로 저장합니다.`,
    priority: 1,
  });
  await chrome.storage.local.set({ disconnectNotified: true });
}
/** A server that answered (even with an auth or HTTP error) is reachable, so not "off". */
async function markConnection(error: unknown) {
  if (!(error instanceof BackupConnectionError)) return;
  if (OFFLINE_CODES.has(error.code)) await markOffline(error);
  else await markOnline();
}
/** Probe the API periodically so a closed Obsidian is noticed even with an empty queue. */
async function healthCheck() {
  const cfg = await config();
  if (!cfg.enabled || !cfg.destinationId) return;
  const meta = await chrome.storage.local.get<BackupMeta>([
    'disconnectedSince',
    'disconnectNotified',
    'lastProbeAt',
  ]);
  const now = Date.now();
  const overdue =
    meta.disconnectedSince !== undefined &&
    !meta.disconnectNotified &&
    now - meta.disconnectedSince >= OFFLINE_NOTIFY_AFTER;
  if (!overdue && now - (meta.lastProbeAt ?? 0) < PROBE_INTERVAL) return;
  await chrome.storage.local.set({ lastProbeAt: now });
  try {
    await (await apiClient()).connect();
  } catch (error) {
    await markConnection(error);
    return;
  }
  await markOnline();
  if (meta.disconnectedSince !== undefined) {
    // Reconnected: do not wait out the exponential backoff of queued notes.
    await db.jobs
      .where('[target+state]')
      .equals([cfg.destinationId, 'pending'])
      .modify((job: BackupJob) => {
        job.due = 0;
      });
    void drain().catch(reportError);
  }
}

interface AutoRun {
  startedAt: number;
  updatedAt: number;
  queue: AutoPlatform[];
  session?: AutoSession;
  /** Finished source tab waiting out its grace period; closed even after a worker restart. */
  closing?: number;
  result: AutoRunResult;
}
let autoLock: Promise<unknown> = Promise.resolve();
function withAutoLock<T>(task: () => Promise<T>): Promise<T> {
  const result = autoLock.then(task);
  autoLock = result.catch(() => {});
  return result;
}
async function autoRun() {
  return (await chrome.storage.session.get<Record<string, AutoRun>>(AUTO_RUN_KEY))[AUTO_RUN_KEY];
}
async function saveAutoRun(run: AutoRun | undefined) {
  if (run) await chrome.storage.session.set({ [AUTO_RUN_KEY]: { ...run, updatedAt: Date.now() } });
  else await chrome.storage.session.remove(AUTO_RUN_KEY);
}
async function autoInterval() {
  const stored = (
    await chrome.storage.local.get<Record<string, { intervalHours?: unknown }>>(AUTO_CONFIG_KEY)
  )[AUTO_CONFIG_KEY];
  return normalizeInterval(stored?.intervalHours);
}
async function ensureAutoAlarm(reset = false) {
  const hours = await autoInterval();
  const alarm = await chrome.alarms.get(AUTO_ALARM);
  if (!hours) {
    if (alarm) await chrome.alarms.clear(AUTO_ALARM);
    return;
  }
  if (reset || !alarm || alarm.periodInMinutes !== hours * 60)
    await chrome.alarms.create(AUTO_ALARM, {
      delayInMinutes: hours * 60,
      periodInMinutes: hours * 60,
    });
}
async function autoStatus() {
  const run = await autoRun();
  const alarm = await chrome.alarms.get(AUTO_ALARM);
  return {
    intervalHours: await autoInterval(),
    running: run ? (run.session?.platform ?? 'starting') : '',
    nextRun: alarm?.scheduledTime ?? 0,
    lastRun:
      (await chrome.storage.local.get<Record<string, AutoRunResult>>(AUTO_RESULT_KEY))[
        AUTO_RESULT_KEY
      ] ?? null,
  };
}
async function knownIds(platform: AutoPlatform) {
  const stored =
    (
      await chrome.storage.local.get<Record<string, Partial<Record<AutoPlatform, string[]>>>>(
        AUTO_KNOWN_KEY,
      )
    )[AUTO_KNOWN_KEY] ?? {};
  const jobs: { key: string; modules: string[] }[] = [];
  await db.jobs.each((job) => {
    jobs.push({ key: job.key, modules: job.modules });
  });
  return {
    stored,
    set: new Set([...(stored[platform] ?? []), ...knownFromJobs(jobs, platform)]),
  };
}
/** Opens the next source tab, or records the finished run. Caller holds the auto lock. */
async function openNextSource(run: AutoRun) {
  if (run.closing !== undefined) {
    await closeUnlessViewed(run.closing);
    run.closing = undefined;
  }
  for (let platform = run.queue.shift(); platform; platform = run.queue.shift()) {
    try {
      const known = [...(await knownIds(platform)).set];
      const tab = await chrome.tabs.create({ url: AUTO_SOURCES[platform], active: false });
      if (tab.id === undefined) throw new Error('탭을 열지 못했습니다.');
      run.session = {
        platform,
        tabId: tab.id,
        startedAt: Date.now(),
        known,
        seen: [],
        fresh: 0,
        idle: 0,
        steps: 0,
      };
      await saveAutoRun(run);
      await chrome.alarms.create(AUTO_WATCHDOG, { when: Date.now() + AUTO_TIMEOUT });
      return;
    } catch {
      run.result[platform] = { fresh: 0, reason: 'error' };
    }
  }
  run.result.finishedAt = Date.now();
  await chrome.storage.local.set({ [AUTO_RESULT_KEY]: run.result });
  await saveAutoRun(undefined);
  await chrome.alarms.clear(AUTO_WATCHDOG);
}
/** Records one source and closes its tab after a short grace period for in-flight saves. */
/** Never close a collection tab the user switched to; it is theirs now. */
async function closeUnlessViewed(tabId: number) {
  try {
    if (!(await chrome.tabs.get(tabId)).active) await chrome.tabs.remove(tabId);
  } catch {
    /* Already closed. */
  }
}
async function finishSource(
  run: AutoRun,
  session: AutoSession,
  reason: AutoStopReason,
  grace: number,
) {
  run.result[session.platform] = { fresh: session.fresh, reason };
  run.session = undefined;
  run.closing = reason === 'interrupted' ? undefined : session.tabId;
  const { stored } = await knownIds(session.platform);
  await chrome.storage.local.set({
    [AUTO_KNOWN_KEY]: {
      ...stored,
      [session.platform]: mergeKnown(stored[session.platform] ?? [], session.seen),
    },
  });
  await saveAutoRun(run);
  // If the worker stops during the grace period, the watchdog still continues the run.
  await chrome.alarms.create(AUTO_WATCHDOG, { when: Date.now() + grace + 60000 });
  setTimeout(() => {
    void withAutoLock(async () => {
      const current = await autoRun();
      if (current && !current.session) await openNextSource(current);
    }).catch(reportError);
  }, grace);
}
function startAutoCollect() {
  return withAutoLock(async () => {
    const existing = await autoRun();
    if (existing && Date.now() - existing.updatedAt < AUTO_TIMEOUT + 120000) return false;
    if (existing?.session) await closeUnlessViewed(existing.session.tabId);
    if (existing?.closing !== undefined) await closeUnlessViewed(existing.closing);
    const now = Date.now();
    const cfg = await config();
    // A source whose backup is off is skipped: its ids would otherwise be recorded as "known",
    // and the first run after enabling it would stop before queueing anything.
    await openNextSource({
      startedAt: now,
      updatedAt: now,
      queue: [
        'x',
        ...(cfg.threadsEnabled ? (['threads'] as const) : []),
        ...(cfg.youtubeEnabled ? (['youtube'] as const) : []),
      ],
      result: { startedAt: now, finishedAt: 0 },
    });
    return true;
  });
}
async function autoHello(sender: chrome.runtime.MessageSender, platform: AutoPlatform) {
  const session = (await autoRun())?.session;
  return {
    ok: true,
    auto: session?.tabId === sender.tab?.id && session?.platform === platform,
  };
}
function autoStepMessage(
  sender: chrome.runtime.MessageSender,
  platform: AutoPlatform,
  ids: unknown,
) {
  return withAutoLock(async () => {
    const run = await autoRun();
    const session = run?.session;
    if (!run || !session || session.tabId !== sender.tab?.id || session.platform !== platform)
      return { ok: true, continue: false };
    if (
      !Array.isArray(ids) ||
      ids.length > 5000 ||
      !ids.every((id) => typeof id === 'string' && /^[\w-]{1,40}$/.test(id))
    )
      throw new Error('자동 수집 데이터 형식이 올바르지 않습니다.');
    const tab = await chrome.tabs.get(session.tabId).catch(() => undefined);
    if (tab?.active) {
      // The user opened the tab: stop scrolling their view and leave the tab open.
      await finishSource(run, session, 'interrupted', 0);
      return { ok: true, continue: false };
    }
    const step = autoStep(session, ids, new Set(session.known));
    if (step.stop) await finishSource(run, step.session, step.stop, 4000);
    else await saveAutoRun({ ...run, session: step.session });
    return { ok: true, continue: !step.stop };
  });
}
function autoWatchdog() {
  return withAutoLock(async () => {
    const run = await autoRun();
    if (!run) return;
    if (run.session && Date.now() - run.session.startedAt < AUTO_TIMEOUT - 1000) return;
    if (run.session) await finishSource(run, run.session, 'timeout', 0);
    else await openNextSource(run);
  });
}
function drain() {
  if (!running)
    running = flush().finally(() => {
      running = undefined;
    });
  return running;
}
async function replayTabs() {
  let contacted = 0;
  await Promise.all(
    (await chrome.tabs.query({})).map(async (tab) => {
      if (tab.id === undefined) return;
      try {
        const reply = await chrome.tabs.sendMessage(tab.id, { type: 'TWE_BACKUP_REPLAY' });
        if (reply?.ok) contacted++;
      } catch {
        /* Only X, Threads and YouTube tabs have a receiver. No page content goes elsewhere. */
      }
    }),
  );
  return contacted;
}
function ownUI(sender: chrome.runtime.MessageSender) {
  return (
    sender.id === chrome.runtime.id &&
    ['backup.html', 'popup.html'].some((path) => sender.url === chrome.runtime.getURL(path))
  );
}
function xSender(sender: chrome.runtime.MessageSender) {
  return (
    sender.id === chrome.runtime.id &&
    sender.tab?.id !== undefined &&
    sender.frameId === 0 &&
    isXPage(sender.url ?? '')
  );
}
function threadsSender(sender: chrome.runtime.MessageSender) {
  return (
    sender.id === chrome.runtime.id &&
    sender.tab?.id !== undefined &&
    sender.frameId === 0 &&
    isThreadsPage(sender.url ?? '')
  );
}
function youtubeSender(sender: chrome.runtime.MessageSender) {
  return (
    sender.id === chrome.runtime.id &&
    sender.tab?.id !== undefined &&
    sender.frameId === 0 &&
    isYoutubePage(sender.url ?? '')
  );
}
async function handle(msg: Record<string, unknown>, sender: chrome.runtime.MessageSender) {
  const ui = ownUI(sender),
    content = xSender(sender),
    threads = threadsSender(sender),
    youtube = youtubeSender(sender);
  if (!ui && !content && !threads && !youtube) throw new Error('허용되지 않은 백업 요청입니다.');
  const source: AutoPlatform | undefined = content
    ? 'x'
    : threads
      ? 'threads'
      : youtube
        ? 'youtube'
        : undefined;
  if (msg.type === 'TWE_BACKUP_CONFIG_GET') return { ok: true, config: await config() };
  if (msg.type === 'TWE_BACKUP_OPEN') {
    await chrome.runtime.openOptionsPage();
    return { ok: true };
  }
  if (msg.type === 'TWE_BACKUP_ENQUEUE' && content) return enqueue(msg.module, msg.records);
  if (msg.type === 'TWE_BACKUP_THREAD' && content) return enqueueThread(msg.bundle);
  if (msg.type === 'TWE_BACKUP_THREADS' && threads) return enqueueThreads(msg.bundle);
  if (msg.type === 'TWE_BACKUP_YOUTUBE' && youtube) return enqueueYoutube(msg.videos);
  if (msg.type === 'TWE_AUTO_HELLO' && source) return autoHello(sender, source);
  if (msg.type === 'TWE_AUTO_STEP' && source) return autoStepMessage(sender, source, msg.ids);
  if (!ui) throw new Error('백업 설정은 확장 프로그램 화면에서만 변경할 수 있습니다.');
  switch (msg.type) {
    case 'TWE_BACKUP_STATUS':
      return status();
    case 'TWE_BACKUP_API_SAVE': {
      await saveApiSettings(msg, await apiSettings(), await config());
      return status();
    }
    case 'TWE_BACKUP_CONFIG_SET': {
      if (typeof msg.enabled !== 'boolean' || !['bookmarks', 'tweets'].includes(String(msg.scope)))
        throw new Error('올바르지 않은 백업 설정입니다.');
      const cfg = await config();
      if (msg.threadsEnabled !== undefined && typeof msg.threadsEnabled !== 'boolean')
        throw new Error('Threads 백업 설정이 올바르지 않습니다.');
      if (msg.youtubeEnabled !== undefined && typeof msg.youtubeEnabled !== 'boolean')
        throw new Error('YouTube 백업 설정이 올바르지 않습니다.');
      if (msg.enabled && !cfg.destinationId) throw new Error('먼저 연결 확인을 실행하세요.');
      if (msg.enabled) await (await apiClient()).connect();
      await chrome.storage.local.set({
        [CONFIG_KEY]: {
          ...cfg,
          enabled: msg.enabled,
          scope: msg.scope,
          threadsEnabled: msg.threadsEnabled ?? cfg.threadsEnabled,
          youtubeEnabled: msg.youtubeEnabled ?? cfg.youtubeEnabled,
        },
      });
      if (msg.enabled) {
        void replayTabs().catch(reportError);
        void drain().catch(reportError);
      }
      return status();
    }
    case 'TWE_BACKUP_RETRY': {
      const cfg = await config();
      if (!cfg.enabled) throw new Error('자동 백업을 켠 뒤 재시도하세요.');
      await db.jobs
        .where('[target+state]')
        .equals([cfg.destinationId, 'pending'])
        .modify((job: BackupJob) => {
          job.due = 0;
        });
      await drain();
      return status();
    }
    case 'TWE_BACKUP_RESCAN': {
      if (!(await config()).enabled) throw new Error('자동 백업을 먼저 켜세요.');
      if (msg.verify === true) {
        const cfg = await config();
        await db.jobs.where('[target+state]').equals([cfg.destinationId, 'done']).delete();
      }
      return { ok: true, tabs: await replayTabs() };
    }
    case 'TWE_AUTO_CONFIG_SET': {
      if (!(AUTO_INTERVALS as readonly unknown[]).includes(msg.intervalHours))
        throw new Error('올바르지 않은 수집 주기입니다.');
      await chrome.storage.local.set({ [AUTO_CONFIG_KEY]: { intervalHours: msg.intervalHours } });
      await ensureAutoAlarm(true);
      return status();
    }
    case 'TWE_AUTO_COLLECT_NOW': {
      if (!(await startAutoCollect())) throw new Error('이미 자동 수집이 진행 중입니다.');
      return status();
    }
    default:
      throw new Error('지원하지 않는 백업 요청입니다.');
  }
}
chrome.runtime.onMessage.addListener((message: unknown, sender, reply) => {
  if (!message || typeof message !== 'object') return;
  const msg = message as Record<string, unknown>;
  if (
    typeof msg.type !== 'string' ||
    !(msg.type.startsWith('TWE_BACKUP_') || msg.type.startsWith('TWE_AUTO_'))
  )
    return;
  void handle(msg, sender).then(reply, (error) => {
    reply({
      ok: false,
      error: error instanceof Error ? error.message : '백업 오류',
      code: error instanceof BackupConnectionError ? error.code : 'BACKUP_ERROR',
    });
  });
  return true;
});
async function initialize() {
  await READY;
  if (!(await chrome.alarms.get(ALARM))) await chrome.alarms.create(ALARM, { periodInMinutes: 1 });
  await ensureAutoAlarm();
  void drain().catch(reportError);
}
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM)
    void healthCheck()
      .catch(reportError)
      .then(() => drain())
      .catch(reportError);
  if (alarm.name === AUTO_ALARM) void startAutoCollect().catch(reportError);
  if (alarm.name === AUTO_WATCHDOG) void autoWatchdog().catch(reportError);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  void withAutoLock(async () => {
    const run = await autoRun();
    if (run?.session?.tabId === tabId) await finishSource(run, run.session, 'error', 0);
  }).catch(reportError);
});
chrome.notifications.onClicked.addListener((id) => {
  if (id !== OFFLINE_NOTIFICATION) return;
  void chrome.runtime.openOptionsPage();
  void chrome.notifications.clear(id);
});
chrome.runtime.onInstalled.addListener(() => {
  void initialize().catch(reportError);
});
chrome.runtime.onStartup.addListener(() => {
  void initialize().catch(reportError);
});
void initialize().catch(reportError);

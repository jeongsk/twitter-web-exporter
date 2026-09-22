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
import { isXPage } from './protocol';

const db = new BackupDatabase();
const ALARM = 'twe-vault-backup-retry';
const CONFIG_KEY = 'vaultBackupConfig';
const READY = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
let running: Promise<void> | undefined;
interface StoredConfig {
  vaultBackupConfig?: Partial<BackupConfig>;
  vaultBackupApi?: ApiSettings;
}
interface BackupMeta {
  lastBackupError?: string;
  lastBackupSuccess?: number;
  lastBackupPath?: string;
  backupPluginVersion?: string;
}
async function config(): Promise<BackupConfig> {
  await READY;
  const value = (await chrome.storage.local.get<StoredConfig>(CONFIG_KEY))[CONFIG_KEY];
  return {
    enabled: value?.enabled === true,
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
  ]);
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
      .filter((j) => j.due <= Date.now() && j.modules.some((m) => acceptsModule(cfg.scope, m)))
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
    } catch (error) {
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
        /* Only X tabs have a receiver. No page content is sent to other tabs. */
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
async function handle(msg: Record<string, unknown>, sender: chrome.runtime.MessageSender) {
  const ui = ownUI(sender),
    content = xSender(sender);
  if (!ui && !content) throw new Error('허용되지 않은 백업 요청입니다.');
  if (msg.type === 'TWE_BACKUP_CONFIG_GET') return { ok: true, config: await config() };
  if (msg.type === 'TWE_BACKUP_OPEN') {
    await chrome.runtime.openOptionsPage();
    return { ok: true };
  }
  if (msg.type === 'TWE_BACKUP_ENQUEUE' && content) return enqueue(msg.module, msg.records);
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
      if (msg.enabled && !cfg.destinationId) throw new Error('먼저 연결 확인을 실행하세요.');
      if (msg.enabled) await (await apiClient()).connect();
      await chrome.storage.local.set({
        [CONFIG_KEY]: { ...cfg, enabled: msg.enabled, scope: msg.scope },
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
    default:
      throw new Error('지원하지 않는 백업 요청입니다.');
  }
}
chrome.runtime.onMessage.addListener((message: unknown, sender, reply) => {
  if (!message || typeof message !== 'object') return;
  const msg = message as Record<string, unknown>;
  if (typeof msg.type !== 'string' || !msg.type.startsWith('TWE_BACKUP_')) return;
  void handle(msg, sender).then(reply, (error) => {
    reply({ ok: false, error: error instanceof Error ? error.message : '백업 오류' });
  });
  return true;
});
async function initialize() {
  await READY;
  if (!(await chrome.alarms.get(ALARM))) await chrome.alarms.create(ALARM, { periodInMinutes: 1 });
  void drain().catch(reportError);
}
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) void drain().catch(reportError);
});
chrome.runtime.onInstalled.addListener(() => {
  void initialize().catch(reportError);
});
chrome.runtime.onStartup.addListener(() => {
  void initialize().catch(reportError);
});
void initialize().catch(reportError);

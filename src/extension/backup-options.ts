import type { BackupStatus } from '@/backup/types';
import {
  normalizeEndpoint,
  normalizeFolder,
  validateApiKey,
  permissionOrigin,
} from '@/backup/rest';
import { BackupConnectionError, withTimeout } from '@/backup/connection-errors';
import { describeResult } from '@/backup/auto-collect';

const field = (id: string) => document.getElementById(id) as HTMLInputElement;
const message = (id: string, value: string) => {
  document.getElementById(id)!.textContent = value;
};
const connection = document.getElementById('connection-state')!;
const connectionError = document.getElementById('connection-error')!;
const help = document.getElementById('connection-help')!;
const apiLink = document.getElementById('api-status-link') as HTMLAnchorElement;
const connectButton = document.getElementById('connect') as HTMLButtonElement;
const intervalField = document.getElementById('auto-interval') as HTMLSelectElement;
const offline = document.getElementById('offline')!;
let working = false;
let polling = false;
let epoch = 0;
let dirty = false;
let connectionFeedback = false;
let actionNotice: string | null = null;
let lastStatus: BackupStatus | undefined;

async function send(request: Record<string, unknown>) {
  let reply;
  try {
    reply = await withTimeout(
      chrome.runtime.sendMessage(request),
      15000,
      '확장 프로그램 응답이 15초 동안 없습니다. chrome://extensions에서 확장 프로그램을 새로고침하고 이 설정 탭을 닫았다 다시 여세요.',
      'WORKER_TIMEOUT',
    );
  } catch (error) {
    if (error instanceof BackupConnectionError) throw error;
    throw new BackupConnectionError(
      '확장 프로그램과 통신하지 못했습니다. 확장 프로그램을 새로고침하고 이 설정 탭을 닫았다 다시 여세요.',
      'WORKER',
    );
  }
  if (!reply?.ok)
    throw new BackupConnectionError(
      typeof reply?.error === 'string' ? reply.error : '백업 요청에 실패했습니다.',
      typeof reply?.code === 'string' ? reply.code : 'BACKUP_ERROR',
    );
  return reply;
}

function updateApiLink() {
  try {
    apiLink.href = normalizeEndpoint(field('endpoint').value.trim()) + '/';
    apiLink.hidden = false;
  } catch {
    apiLink.removeAttribute('href');
    apiLink.hidden = true;
  }
}
function connectionState(kind: 'pending' | 'success' | 'error', text: string) {
  connectionFeedback = true;
  connection.dataset.state = kind;
  message('connection-state', text);
}
function showConnectionError(error: unknown, input?: string) {
  const text = error instanceof Error ? error.message : '연결 확인 중 오류가 발생했습니다.';
  const code = error instanceof BackupConnectionError ? error.code : 'VALIDATION';
  connectionState('error', '연결 확인에 실패했습니다. 아래 안내를 확인하세요.');
  connectionError.textContent = text;
  connectionError.hidden = false;
  connectionError.dataset.code = code;
  help.hidden = code !== 'TLS_OR_NETWORK';
  updateApiLink();
  if (input) {
    field(input).setAttribute('aria-invalid', 'true');
    field(input).focus({ preventScroll: true });
  }
  connectionError.scrollIntoView({ block: 'nearest' });
}
function show(status: BackupStatus, populate = false) {
  lastStatus = status;
  if (populate) {
    field('endpoint').value = status.api.endpoint;
    field('folder').value = status.api.folder;
    field('scope').value = status.config.scope;
    field('enabled').checked = status.config.enabled;
    field('threads-enabled').checked = status.config.threadsEnabled === true;
    field('youtube-enabled').checked = status.config.youtubeEnabled === true;
    field('api-key').placeholder = status.api.hasApiKey
      ? '저장된 키 사용 (변경 시 새 키 입력)'
      : 'Obsidian 설정에서 복사한 API 키';
    updateApiLink();
  }
  // Polling updates queue counters, NEVER overwrites a connection failure or hides its guidance.
  if (!connectionFeedback)
    message(
      'connection-state',
      status.api.hasApiKey
        ? `연결 설정 저장됨 · ${status.api.endpoint} · v${status.api.pluginVersion} (실시간 연결 여부는 연결 확인으로 점검)`
        : '아직 연결되지 않았습니다.',
    );
  message(
    'counts',
    `${status.config.enabled ? '자동 백업 켜짐' : '자동 백업 꺼짐'} · 대기 ${status.pending} · 완료 ${status.done} · 재시도 대기 ${status.failed}${status.otherDestination ? ` · 이전 저장 위치의 대기 작업 ${status.otherDestination}` : ''}`,
  );
  message(
    'last-success',
    status.lastSuccess
      ? '최근 성공: ' + new Date(status.lastSuccess).toLocaleString('ko-KR')
      : '아직 저장한 노트가 없습니다.',
  );
  message('last-path', status.lastPath);
  message('error', actionNotice ?? status.lastError);
  offline.hidden = !status.disconnectedSince;
  if (status.disconnectedSince)
    offline.textContent = `Obsidian 연결 끊김 · ${new Date(status.disconnectedSince).toLocaleString('ko-KR')}부터 · 대기열에 보관 중이며 연결되면 자동으로 저장합니다.`;
  showAuto(status.autoCollect, populate);
}
const time = (value: number) => new Date(value).toLocaleString('ko-KR');
function showAuto(auto: BackupStatus['autoCollect'], populate: boolean) {
  if (populate) intervalField.value = String(auto.intervalHours);
  const running = {
    x: 'X 북마크',
    threads: 'Threads 저장 목록',
    youtube: 'YouTube 좋아요',
    starting: '준비',
  }[auto.running];
  message(
    'auto-state',
    running
      ? `수집 중 · ${running}`
      : auto.intervalHours
        ? `${auto.intervalHours}시간마다 수집${auto.nextRun ? ` · 다음 수집 ${time(auto.nextRun)}` : ''}`
        : '자동 수집 꺼짐 · 지금 수집으로 직접 실행할 수 있습니다.',
  );
  const last = auto.lastRun;
  message(
    'auto-last',
    last
      ? `최근 수집 ${time(last.finishedAt || last.startedAt)} · X ${describeResult(last.x)} · Threads ${describeResult(last.threads)} · YouTube ${describeResult(last.youtube)}`
      : '아직 자동 수집을 실행하지 않았습니다.',
  );
}
function showNotice(text: string) {
  actionNotice = text;
  message('error', text);
}
async function perform(area: 'connection' | 'queue', action: () => Promise<void>) {
  if (working) return;
  working = true;
  epoch++;
  const buttons = [...document.querySelectorAll('button')];
  buttons.forEach((b) => {
    b.disabled = true;
  });
  if (area === 'connection') {
    connectButton.textContent = '연결 확인 중…';
    connectButton.setAttribute('aria-busy', 'true');
    connectionError.hidden = true;
    help.hidden = true;
    for (const id of ['endpoint', 'api-key', 'folder', 'privacy'])
      field(id).removeAttribute('aria-invalid');
  } else {
    actionNotice = null;
    message('error', '');
  }
  try {
    await action();
  } catch (error) {
    if (area === 'connection') showConnectionError(error);
    else showNotice(error instanceof Error ? error.message : '백업 오류');
  } finally {
    working = false;
    buttons.forEach((b) => {
      b.disabled = false;
    });
    connectButton.textContent = '연결 확인 · 저장';
    connectButton.removeAttribute('aria-busy');
  }
}

for (const id of [
  'endpoint',
  'api-key',
  'folder',
  'scope',
  'enabled',
  'privacy',
  'threads-enabled',
  'youtube-enabled',
]) {
  field(id).addEventListener('input', () => {
    dirty = true;
    field(id).removeAttribute('aria-invalid');
    if (id === 'endpoint') updateApiLink();
  });
}
connectButton.addEventListener('click', () => {
  if (working) return;
  epoch++;
  let input = 'endpoint';
  try {
    const endpoint = normalizeEndpoint(field('endpoint').value.trim());
    input = 'folder';
    const folder = normalizeFolder(field('folder').value.trim());
    input = 'api-key';
    const apiKey = field('api-key').value.trim();
    if (apiKey) validateApiKey(apiKey);
    else if (!lastStatus?.api.hasApiKey || lastStatus.api.endpoint !== endpoint)
      throw new Error(
        'API 키를 입력하세요. 대상 볼트의 Local REST API 설정에서 키를 복사할 수 있습니다.',
      );
    input = 'privacy';
    if (!field('privacy').checked)
      throw new Error('볼트 동기화·공개 범위를 확인하고 위 체크박스를 선택하세요.');
    void perform('connection', async () => {
      connectionState(
        'pending',
        'Chrome 로컬 API 접근 권한을 확인하고 있습니다. 권한 창이 나타나면 허용하세요.',
      );
      // Synchronous up to this call: request permission while the click still has user activation.
      const permission = chrome.permissions.request({ origins: [permissionOrigin(endpoint)] });
      const allowed = await withTimeout(
        permission,
        20000,
        '로컬 API 접근 권한 확인이 20초 동안 완료되지 않았습니다. Chrome의 권한 창을 확인하고 다시 눌러주세요.',
        'PERMISSION_TIMEOUT',
      );
      if (!allowed)
        throw new BackupConnectionError(
          '로컬 API 접근 권한이 거부되었습니다. 다시 연결을 눌러 Chrome의 권한 요청을 허용하세요.',
          'PERMISSION_DENIED',
        );
      connectionState('pending', `${endpoint}에 연결하고 API 키를 확인하고 있습니다…`);
      const state: BackupStatus = await send({
        type: 'TWE_BACKUP_API_SAVE',
        endpoint,
        apiKey,
        folder,
        privacyAcknowledged: true,
      });
      field('api-key').value = '';
      show(state, true);
      connectionState(
        'success',
        `연결 확인 완료 · 연결 설정 저장됨 · ${state.api.endpoint} · v${state.api.pluginVersion}`,
      );
    });
  } catch (error) {
    showConnectionError(error, input);
  }
});
document.getElementById('apply')!.addEventListener(
  'click',
  () =>
    void perform('queue', async () => {
      show(
        await send({
          type: 'TWE_BACKUP_CONFIG_SET',
          enabled: field('enabled').checked,
          scope: field('scope').value,
          threadsEnabled: field('threads-enabled').checked,
          youtubeEnabled: field('youtube-enabled').checked,
        }),
        true,
      );
    }),
);
document.getElementById('retry')!.addEventListener(
  'click',
  () =>
    void perform('queue', async () => {
      await send({ type: 'TWE_BACKUP_RETRY' });
      show(await send({ type: 'TWE_BACKUP_STATUS' }));
    }),
);
intervalField.addEventListener(
  'change',
  () =>
    void perform('queue', async () => {
      const state: BackupStatus = await send({
        type: 'TWE_AUTO_CONFIG_SET',
        intervalHours: Number(intervalField.value),
      });
      show(state);
      showAuto(state.autoCollect, true);
      showNotice(
        state.autoCollect.intervalHours
          ? `자동 수집 주기를 ${state.autoCollect.intervalHours}시간으로 저장했습니다.`
          : '자동 수집을 껐습니다.',
      );
    }),
);
document.getElementById('collect-now')!.addEventListener(
  'click',
  () =>
    void perform('queue', async () => {
      show(await send({ type: 'TWE_AUTO_COLLECT_NOW' }));
      const cfg = lastStatus?.config;
      const sources = [
        'X 북마크',
        ...(cfg?.threadsEnabled ? ['Threads 저장 목록'] : []),
        ...(cfg?.youtubeEnabled ? ['YouTube 좋아요'] : []),
      ];
      showNotice(`${sources.join('·')}을(를) 비활성 탭에서 수집하고 있습니다.`);
    }),
);
for (const [id, verify] of [
  ['rescan', false],
  ['verify', true],
] as const) {
  document.getElementById(id)!.addEventListener(
    'click',
    () =>
      void perform('queue', async () => {
        const reply = await send({ type: 'TWE_BACKUP_RESCAN', verify });
        showNotice(
          reply.tabs
            ? `${reply.tabs}개 X·Threads·YouTube 탭의 기존 데이터를 확인하고 있습니다.`
            : 'X·Threads 저장 목록 또는 YouTube 좋아요 탭을 열고 새로고침한 뒤 다시 실행하세요.',
        );
      }),
  );
}
updateApiLink();
const initialEpoch = epoch;
void send({ type: 'TWE_BACKUP_STATUS' })
  .then((state) => {
    if (!working && epoch === initialEpoch) show(state, !dirty);
  })
  .catch((error) => {
    if (!connectionFeedback) showConnectionError(error);
  });
setInterval(() => {
  if (working || polling || document.hidden) return;
  polling = true;
  const pollEpoch = epoch;
  void send({ type: 'TWE_BACKUP_STATUS' })
    .then((state) => {
      if (!working && pollEpoch === epoch) show(state);
    })
    .catch((error) => {
      if (!working && pollEpoch === epoch && !connectionFeedback) showConnectionError(error);
    })
    .finally(() => {
      polling = false;
    });
}, 3000);

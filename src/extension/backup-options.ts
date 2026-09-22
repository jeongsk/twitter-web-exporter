import type { BackupStatus } from '@/backup/types';
import { normalizeEndpoint, permissionOrigin } from '@/backup/rest';
const field = (id: string) => document.getElementById(id) as HTMLInputElement;
const message = (id: string, value: string) => {
  document.getElementById(id)!.textContent = value;
};
let working = false;
let noticeUntil = 0;
async function send(request: Record<string, unknown>) {
  const reply = await chrome.runtime.sendMessage(request);
  if (!reply?.ok) throw new Error(reply?.error ?? '백업 요청에 실패했습니다.');
  return reply;
}
function show(status: BackupStatus, initial = false) {
  if (initial) {
    field('endpoint').value = status.api.endpoint;
    field('folder').value = status.api.folder;
    field('scope').value = status.config.scope;
    field('enabled').checked = status.config.enabled;
    field('api-key').placeholder = status.api.hasApiKey
      ? '저장된 키 사용 (변경 시 새 키 입력)'
      : 'Obsidian 설정에서 복사한 API 키';
  }
  message(
    'connection-state',
    status.api.hasApiKey
      ? `연결 설정 저장됨 · ${status.api.endpoint} · v${status.api.pluginVersion}`
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
  if (Date.now() > noticeUntil) message('error', status.lastError);
}
function showNotice(text: string) {
  noticeUntil = Date.now() + 15000;
  message('error', text);
}
async function perform(action: () => Promise<void>) {
  if (working) return;
  working = true;
  const buttons = [...document.querySelectorAll('button')];
  buttons.forEach((b) => {
    b.disabled = true;
  });
  try {
    noticeUntil = 0;
    message('error', '');
    await action();
  } catch (error) {
    showNotice(error instanceof Error ? error.message : '백업 오류');
  } finally {
    working = false;
    buttons.forEach((b) => {
      b.disabled = false;
    });
  }
}
document.getElementById('connect')!.addEventListener('click', () => {
  if (working) return;
  try {
    const endpoint = normalizeEndpoint(field('endpoint').value.trim());
    if (!field('privacy').checked)
      throw new Error('볼트 동기화·공개 범위를 확인하고 체크박스를 선택하세요.');
    // Start the permission prompt inside the user gesture, not after an async boundary.
    const permission = chrome.permissions.request({ origins: [permissionOrigin(endpoint)] });
    void perform(async () => {
      if (!(await permission)) throw new Error('로컬 API 접근 권한이 거부되었습니다.');
      const state = await send({
        type: 'TWE_BACKUP_API_SAVE',
        endpoint,
        apiKey: field('api-key').value.trim(),
        folder: field('folder').value.trim(),
        privacyAcknowledged: true,
      });
      field('api-key').value = '';
      show(state, true);
    });
  } catch (error) {
    showNotice((error as Error).message);
  }
});
document.getElementById('apply')!.addEventListener(
  'click',
  () =>
    void perform(async () => {
      show(
        await send({
          type: 'TWE_BACKUP_CONFIG_SET',
          enabled: field('enabled').checked,
          scope: field('scope').value,
        }),
        true,
      );
    }),
);
document.getElementById('retry')!.addEventListener(
  'click',
  () =>
    void perform(async () => {
      await send({ type: 'TWE_BACKUP_RETRY' });
      show(await send({ type: 'TWE_BACKUP_STATUS' }));
    }),
);
for (const [id, verify] of [
  ['rescan', false],
  ['verify', true],
] as const) {
  document.getElementById(id)!.addEventListener(
    'click',
    () =>
      void perform(async () => {
        const reply = await send({ type: 'TWE_BACKUP_RESCAN', verify });
        showNotice(
          reply.tabs
            ? `${reply.tabs}개 X 탭의 기존 데이터를 확인하고 있습니다.`
            : 'X 탭을 열고 새로고침한 뒤 다시 실행하세요.',
        );
      }),
  );
}
void send({ type: 'TWE_BACKUP_STATUS' })
  .then((s) => show(s, true))
  .catch((e) => showNotice(e.message));
setInterval(() => {
  if (!working && !document.hidden)
    void send({ type: 'TWE_BACKUP_STATUS' })
      .then((s) => show(s))
      .catch(() => {});
}, 3000);

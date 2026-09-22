import { CHANNEL, MAX_BUFFER_CHARS, isCapturePacket, normalizeAccountId } from './protocol';
import type { MenuAction } from '@/platform/types';
import type { BridgeState } from './state';

/** ISOLATED world bootstrap. Start buffering before loading the much larger UI bundle. */
const state: BridgeState = {
  accountId: 'unknown',
  hookReady: false,
  ready: false,
  error: '',
  dropped: 0,
  queue: [],
  bufferedChars: 0,
  menus: new Map(),
};
window.__TWE_CHROME_BRIDGE__ = state;
let started = false;
let domReady = document.readyState !== 'loading';

function startApp() {
  if (started || !domReady || !state.hookReady) return;
  started = true;
  const appUrl = chrome.runtime.getURL('app.js');
  void import(/* @vite-ignore */ appUrl).catch((error: unknown) => {
    state.error = '확장 프로그램을 불러오지 못했습니다. 확장 프로그램과 X 탭을 새로고침하세요.';
    console.error('[twitter-web-exporter]', state.error, error);
  });
}

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (event.source !== window || event.origin !== location.origin) return;
  const data = event.data as Record<string, unknown> | null;
  if (!data || data.channel !== CHANNEL) return;
  if (data.type === 'ready') {
    state.hookReady = true;
    // Only the reply to the DOM-ready hello can select the account DB. Earlier
    // queued messages may have been created before X populated its metadata.
    if (!started && domReady && data.phase === 'dom-ready') {
      state.accountId = normalizeAccountId(data.accountId);
      startApp();
    }
    return;
  }
  if (!isCapturePacket(data)) return;
  if (!started && data.accountId !== 'unknown') state.accountId = data.accountId;
  // A SPA account switch must not mix records into the previous account's database.
  if (started && data.accountId !== 'unknown' && data.accountId !== state.accountId) {
    state.error =
      '로그인 계정이 변경되었습니다. 데이터 혼합을 막기 위해 수집을 중지했습니다. X 탭을 새로고침하세요.';
    state.dropped++;
    return;
  }
  if (state.error) return;
  if (state.listener) {
    state.listener({ method: data.method, url: data.url }, data);
  } else if (
    state.queue.length < 100 &&
    state.bufferedChars + data.responseText.length <= MAX_BUFFER_CHARS
  ) {
    state.queue.push(data);
    state.bufferedChars += data.responseText.length;
  } else {
    state.dropped++;
    console.warn('[twitter-web-exporter] Startup buffer is full; a response was skipped.');
  }
});

function hello() {
  window.postMessage(
    { channel: CHANNEL, type: 'hello', phase: domReady ? 'dom-ready' : 'early' },
    location.origin,
  );
}
if (!domReady) {
  document.addEventListener(
    'DOMContentLoaded',
    () => {
      domReady = true;
      hello();
    },
    { once: true },
  );
} else {
  hello();
}
hello();
setTimeout(() => {
  if (!state.hookReady)
    state.error = 'X 네트워크 수집기가 준비되지 않았습니다. X 탭을 새로고침하세요.';
}, 10000);

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !message || typeof message !== 'object') return;
  const msg = message as { type?: string; action?: MenuAction };
  if (msg.type === 'TWE_BACKUP_REPLAY') {
    if (!state.backupReplay || state.error) {
      sendResponse({ ok: false });
      return;
    }
    void state.backupReplay().catch((error) => {
      state.backupError = error instanceof Error ? error.message : '기존 데이터 백업 실패';
    });
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === 'TWE_STATUS') {
    void (async () => {
      const counts = state.getCounts ? await state.getCounts() : null;
      sendResponse({
        ready: state.ready,
        hookReady: state.hookReady,
        error: state.error,
        dropped: state.dropped,
        backupError: state.backupError ?? '',
        counts,
        url: location.href,
      });
    })().catch(() => sendResponse({ ready: false, error: '데이터베이스 상태를 읽지 못했습니다.' }));
    return true;
  }
  if (
    msg.type === 'TWE_COMMAND' &&
    (msg.action === 'toggle-panel' || msg.action === 'open-settings')
  ) {
    const handler = state.menus.get(msg.action);
    if (!handler) {
      sendResponse({
        ok: false,
        error: '제어판 준비 중입니다. X 탭을 새로고침한 뒤 다시 시도하세요.',
      });
      return;
    }
    handler();
    sendResponse({ ok: true });
  }
});

import { isXPage } from './protocol';
import type { MenuAction } from '@/platform/types';

type Status = {
  ready?: boolean;
  error?: string;
  dropped?: number;
  counts?: { tweets: number; users: number; captures: number } | null;
};
const status = document.getElementById('status')!;
const count = document.getElementById('counts')!;
const panelButton = document.getElementById('panel') as HTMLButtonElement;
const settingsButton = document.getElementById('settings') as HTMLButtonElement;
let tabId: number | undefined;

async function command(action: MenuAction) {
  if (tabId === undefined) return;
  try {
    const result = await chrome.tabs.sendMessage(tabId, { type: 'TWE_COMMAND', action });
    if (!result?.ok) throw new Error(result?.error ?? '제어판을 열지 못했습니다.');
    window.close();
  } catch (error) {
    status.textContent = (error as Error).message;
  }
}
panelButton.addEventListener('click', () => void command('toggle-panel'));
settingsButton.addEventListener('click', () => void command('open-settings'));
document.getElementById('bookmarks')!.addEventListener('click', () => {
  void chrome.tabs.create({ url: 'https://x.com/i/bookmarks' });
});
document.getElementById('version')!.textContent = `v${chrome.runtime.getManifest().version}`;

void (async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined || !isXPage(tab.url ?? '')) {
    status.textContent = 'X 페이지에서 사용할 수 있습니다. 북마크를 열어 시작하세요.';
    return;
  }
  tabId = tab.id;
  try {
    const result: Status = await chrome.tabs.sendMessage(tabId, { type: 'TWE_STATUS' });
    status.textContent =
      result.error ||
      (result.ready
        ? '수집 준비 완료 · 페이지를 스크롤해 데이터를 모으세요.'
        : '제어판 준비 중입니다. 잠시 후 다시 열어주세요.');
    panelButton.disabled = settingsButton.disabled = !result.ready;
    if (result.counts) {
      count.textContent = `게시물 ${result.counts.tweets.toLocaleString()} · 사용자 ${result.counts.users.toLocaleString()}`;
    }
    if (result.dropped)
      status.textContent += ` 누락된 응답 ${result.dropped}개: 페이지를 다시 조회하세요.`;
  } catch {
    status.textContent = '확장 프로그램을 설치·업데이트한 뒤에는 열린 X 탭을 새로고침하세요.';
  }
})().catch(() => {
  status.textContent = '현재 탭을 확인하지 못했습니다. X 페이지에서 다시 열어주세요.';
});

document.getElementById('backup')!.addEventListener('click', () => {
  void chrome.runtime.openOptionsPage();
});

import type { MenuAction, ResponseListener } from '@/platform/types';
import { getBridge } from './state';

export function getAccountId(): string {
  return getBridge().accountId;
}

export function registerMenuCommand(label: string, handler: () => void, action?: MenuAction) {
  void label;
  if (action) getBridge().menus.set(action, handler);
}

export function observeResponses(listener: ResponseListener) {
  const state = getBridge();
  // All modules are registered synchronously by main.tsx before this microtask runs.
  queueMicrotask(() => {
    state.listener = listener;
    for (const packet of state.queue.splice(0)) {
      listener({ method: packet.method, url: packet.url }, packet);
    }
    state.bufferedChars = 0;
  });
}

export { notifyTweetsCaptured } from '@/backup/client';
export const supportsVaultBackup = true;
export async function openVaultBackup() {
  const reply = await chrome.runtime.sendMessage({ type: 'TWE_BACKUP_OPEN' });
  if (!reply?.ok) throw new Error(reply?.error ?? '백업 설정을 열지 못했습니다.');
}

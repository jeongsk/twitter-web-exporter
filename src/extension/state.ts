import type { MenuAction, ResponseListener } from '@/platform/types';
import type { CapturePacket } from './protocol';

export interface BridgeState {
  accountId: string;
  hookReady: boolean;
  ready: boolean;
  error: string;
  dropped: number;
  queue: CapturePacket[];
  bufferedChars: number;
  listener?: ResponseListener;
  menus: Map<MenuAction, () => void>;
  backupReplay?: () => Promise<void>;
  backupError?: string;
  getCounts?: () => Promise<{ tweets: number; users: number; captures: number } | null>;
}

declare global {
  interface Window {
    __TWE_CHROME_BRIDGE__?: BridgeState;
  }
}

export function getBridge(): BridgeState {
  const state = window.__TWE_CHROME_BRIDGE__;
  if (!state) throw new Error('Chrome content bridge has not initialized.');
  return state;
}

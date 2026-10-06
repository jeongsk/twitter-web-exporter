import type { Signal } from '@preact/signals';
import type { ThreadsSource } from './source';

export interface ThreadsPanelState {
  savedCount: number;
  replyCount: number;
  queued: number;
  busy: boolean;
  notice: string;
  error: string;
}
export interface ThreadsPanelProps {
  state: Signal<ThreadsPanelState>;
  visible: Signal<boolean>;
  settingsOpen: Signal<boolean>;
  source: ThreadsSource;
  onToggle: () => void;
  onScan: () => void;
  onBackup: () => void;
  onError: (error: unknown) => void;
}
export type ThreadsPanelView = 'saved' | 'replies';

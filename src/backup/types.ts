import type { AutoRunResult } from './auto-collect';
/** Data-only contract. No API key is exposed to content scripts or the X page. */
export const BACKUP_MODULES = [
  'BookmarksModule',
  'LikesModule',
  'UserTweetsModule',
  'UserMediaModule',
  'TweetDetailModule',
  'SearchTimelineModule',
  'HomeTimelineModule',
  'ListTimelineModule',
  'CommunityTimelineModule',
] as const;
export type BackupScope = 'bookmarks' | 'tweets';
export type BackupRecord = {
  id: string;
  text: string;
  screenName: string;
  name: string;
  published: string;
  replyTo?: string;
  conversationId?: string;
  links: string[];
  media: { type: string; url: string; alt: string }[];
  related: { id: string; screenName: string; text: string; kind: 'quote' | 'repost' }[];
};
export type BackupConfig = {
  enabled: boolean;
  scope: BackupScope;
  destinationId: string;
  threadsEnabled?: boolean;
};
export const DEFAULT_BACKUP: BackupConfig = {
  enabled: false,
  scope: 'bookmarks',
  destinationId: '',
};
export type BackupStatus = {
  ok: boolean;
  config: BackupConfig;
  pending: number;
  done: number;
  failed: number;
  otherDestination: number;
  lastError: string;
  lastSuccess: number;
  lastPath: string;
  api: { endpoint: string; folder: string; hasApiKey: boolean; pluginVersion: string };
  disconnectedSince: number;
  autoCollect: {
    intervalHours: number;
    running: string;
    nextRun: number;
    lastRun: AutoRunResult | null;
  };
};
export function acceptsModule(scope: BackupScope, module: string): boolean {
  return scope === 'bookmarks'
    ? module === 'BookmarksModule'
    : (BACKUP_MODULES as readonly string[]).includes(module);
}

export type ThreadBackup = { root: BackupRecord; replies: BackupRecord[]; limited: boolean };
export const MAX_THREAD_REPLIES = 1000;
export const MAX_THREAD_BYTES = 4 * 1024 * 1024;

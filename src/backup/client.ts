import type { Tweet } from '@/types';
import { captureRecord } from './capture';
import { acceptsModule, BACKUP_MODULES, type BackupConfig } from './types';
import { findBookmarkedRoots, collectBookmarkedThread } from './thread-source';

/** This module is included only in the isolated Chrome app, never the MAIN observer. */
export async function getBackupConfig(): Promise<BackupConfig> {
  const reply = await chrome.runtime.sendMessage({ type: 'TWE_BACKUP_CONFIG_GET' });
  if (!reply?.ok) throw new Error(reply?.error ?? '백업 설정을 읽지 못했습니다.');
  return reply.config;
}
export async function notifyTweetsCaptured(module: string, tweets: Tweet[]) {
  if (!tweets.length) return;
  const config = await getBackupConfig();
  if (!config.enabled || !(BACKUP_MODULES as readonly string[]).includes(module)) return;
  // Even in bookmarks-only mode, a TweetDetail capture can enrich an existing bookmark.
  // Resolve from the site's existing database; never issue additional X API requests.
  const { db } = await import('@/core/database');
  const rootIds = await findBookmarkedRoots(db, tweets);
  const bundled = new Set<string>();
  for (const id of rootIds) {
    const bundle = await collectBookmarkedThread(db, id);
    const reply = await chrome.runtime.sendMessage({ type: 'TWE_BACKUP_THREAD', bundle });
    if (!reply?.ok) throw new Error(reply?.error ?? '댓글 묶음을 백업 대기열에 넣지 못했습니다.');
    [bundle.root, ...bundle.replies].forEach((record) => bundled.add(record.id));
  }
  if (!acceptsModule(config.scope, module)) return;
  const standalone = tweets.filter((tweet) => !bundled.has(tweet.rest_id));
  for (let i = 0; i < standalone.length; i += 5) {
    const records = standalone.slice(i, i + 5).map((tweet) => {
      const record = captureRecord(tweet);
      if (!record) throw new Error(`백업할 게시물 형식이 올바르지 않습니다: ${tweet.rest_id}`);
      return record;
    });
    const reply = await chrome.runtime.sendMessage({ type: 'TWE_BACKUP_ENQUEUE', module, records });
    if (!reply?.ok) throw new Error(reply?.error ?? '백업 대기열에 저장하지 못했습니다.');
  }
}

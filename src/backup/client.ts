import type { Tweet } from '@/types';
import { captureRecord } from './capture';
import { acceptsModule, type BackupConfig } from './types';

/** This module is included only in the isolated Chrome app, never the MAIN observer. */
export async function getBackupConfig(): Promise<BackupConfig> {
  const reply = await chrome.runtime.sendMessage({ type: 'TWE_BACKUP_CONFIG_GET' });
  if (!reply?.ok) throw new Error(reply?.error ?? '백업 설정을 읽지 못했습니다.');
  return reply.config;
}
export async function notifyTweetsCaptured(module: string, tweets: Tweet[]) {
  if (!tweets.length) return;
  const config = await getBackupConfig();
  if (!config.enabled || !acceptsModule(config.scope, module)) return;
  for (let i = 0; i < tweets.length; i += 5) {
    const records = tweets.slice(i, i + 5).map((tweet) => {
      const record = captureRecord(tweet);
      if (!record) throw new Error(`백업할 게시물 형식이 올바르지 않습니다: ${tweet.rest_id}`);
      return record;
    });
    const reply = await chrome.runtime.sendMessage({ type: 'TWE_BACKUP_ENQUEUE', module, records });
    if (!reply?.ok) throw new Error(reply?.error ?? '백업 대기열에 저장하지 못했습니다.');
  }
}

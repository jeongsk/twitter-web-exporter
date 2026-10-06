import type { Tweet } from '@/types';
import { captureRecord } from './capture';
import { MAX_THREAD_REPLIES, type ThreadBackup } from './types';
import { orderThreadReplies } from './thread';

export interface ThreadSource {
  getBackupTweets(ids: string[]): Promise<Tweet[]>;
  getBookmarkedBackupIds(ids: string[]): Promise<string[]>;
  getBackupChildren(ids: string[], limit: number): Promise<Tweet[]>;
}

/** Follow actual reply edges, not page proximity or conversation ID alone. */
export async function findBookmarkedRoots(source: ThreadSource, changed: Tweet[]) {
  const seen = new Set<string>();
  const known = new Map(changed.map((t) => [t.rest_id, t]));
  let frontier = changed.map((t) => t.rest_id);
  for (let depth = 0; frontier.length; depth++) {
    if (depth > MAX_THREAD_REPLIES) throw new Error('댓글 연결 깊이가 1,000단계를 초과합니다.');
    const ids = [...new Set(frontier)].filter((id) => /^\d{1,30}$/.test(id) && !seen.has(id));
    if (!ids.length) break;
    ids.forEach((id) => seen.add(id));
    const missing = ids.filter((id) => !known.has(id));
    for (const t of await source.getBackupTweets(missing)) known.set(t.rest_id, t);
    frontier = ids.flatMap((id) => {
      const legacy = known.get(id)?.legacy;
      return [legacy?.in_reply_to_status_id_str, legacy?.conversation_id_str].filter(
        (id): id is string => !!id && !seen.has(id),
      );
    });
  }
  return source.getBookmarkedBackupIds([...seen]);
}

export async function collectBookmarkedThread(
  source: ThreadSource,
  rootId: string,
): Promise<ThreadBackup> {
  const [tweet] = await source.getBackupTweets([rootId]);
  const root = tweet && captureRecord(tweet);
  if (!root) throw new Error(`북마크 원문을 읽을 수 없습니다: ${rootId}`);
  const seen = new Set([rootId]);
  const replies: ThreadBackup['replies'] = [];
  let frontier = [rootId],
    limited = false;
  while (frontier.length) {
    const remaining = MAX_THREAD_REPLIES - replies.length;
    const children = await source.getBackupChildren(frontier, remaining + 1);
    if (children.length > remaining) limited = true;
    frontier = [];
    for (const child of children.slice(0, remaining)) {
      if (seen.has(child.rest_id)) continue;
      seen.add(child.rest_id);
      const record = captureRecord(child);
      if (!record) {
        limited = true;
        continue;
      }
      if (
        root.conversationId &&
        record.conversationId &&
        root.conversationId !== record.conversationId
      )
        continue;
      replies.push(record);
      frontier.push(record.id);
    }
    if (limited && replies.length >= MAX_THREAD_REPLIES) break;
  }
  return { root, replies: orderThreadReplies(root, replies).map((r) => r.record), limited };
}

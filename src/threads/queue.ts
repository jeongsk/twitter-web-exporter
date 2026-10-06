import type { BackupDatabase } from '@/backup/queue';
import { MAX_THREAD_BYTES, type BackupConfig } from '@/backup/types';
import { isThreadsBundle, orderedReplies, mergeThreadsPost, threadsStorageId } from './model';
import { renderThreadsNote } from './format';

/** The worker serializes ingests. Destination and platform both participate in every key. */
export async function queueThreads(db: BackupDatabase, input: unknown, cfg: BackupConfig) {
  if (!cfg.enabled || !cfg.threadsEnabled) return { ok: true, accepted: 0, paused: true };
  if (!cfg.destinationId || !isThreadsBundle(input))
    throw new Error('Threads 백업 설정 또는 게시물 형식이 올바르지 않습니다.');
  if (new TextEncoder().encode(JSON.stringify(input)).length > MAX_THREAD_BYTES)
    throw new Error('Threads 전송 크기가 4 MiB를 초과합니다.');
  const thread = `${cfg.destinationId}:threads:${threadsStorageId(input.root.code)}`;
  const previous = await db.threadsItems.where('thread').equals(thread).toArray();
  const merged = new Map(previous.map((item) => [item.post.code, item.post]));
  for (const post of [input.root, ...input.replies])
    merged.set(post.code, mergeThreadsPost(merged.get(post.code), post));
  const root = merged.get(input.root.code)!;
  const all = orderedReplies(root, [...merged.values()]);
  const replies = all.slice(0, 1000).map((item) => item.post);
  const limited = input.limited || previous.some((item) => item.limited) || all.length > 1000;
  const note = await renderThreadsNote({ root, replies, limited });
  const key = `${cfg.destinationId}:threads:${note.id}:${note.hash}`;
  await db.transaction('rw', db.jobs, db.threadsItems, async () => {
    const exists = await db.jobs.get(key);
    if (!exists && (await db.jobs.where('state').equals('pending').count()) >= 5000)
      throw new Error('백업 대기열이 5,000개에 도달했습니다. 처리 후 다시 수집하세요.');
    await db.threadsItems.bulkPut(
      [root, ...replies].map((post) => ({
        key: `${thread}:${post.code}`,
        thread,
        post,
        limited: post.code === root.code && limited,
      })),
    );
    if (!exists)
      await db.jobs.add({
        ...note,
        key,
        target: cfg.destinationId,
        state: 'pending',
        modules: ['ThreadsSavedModule'],
        due: 0,
        attempts: 0,
        error: '',
        createdAt: Date.now(),
      });
  });
  return { ok: true, accepted: 1, replies: replies.length, limited };
}

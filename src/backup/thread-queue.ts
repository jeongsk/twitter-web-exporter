import type { BackupDatabase } from './queue';
import { isThreadBackup, orderThreadReplies, renderThreadNote } from './thread';
import {
  MAX_THREAD_BYTES,
  MAX_THREAD_REPLIES,
  type BackupConfig,
  type BackupRecord,
} from './types';

/** Caller serializes thread ingests. Union observations so a second tab cannot erase replies. */
export async function queueThread(db: BackupDatabase, input: unknown, cfg: BackupConfig) {
  if (!cfg.enabled) return { ok: true, accepted: 0, paused: true };
  if (!cfg.destinationId) throw new Error('백업 저장 위치를 먼저 연결하세요.');
  if (!isThreadBackup(input))
    throw new Error('댓글 묶음 형식이나 원문 연결 관계가 올바르지 않습니다.');
  if (new TextEncoder().encode(JSON.stringify(input)).length > MAX_THREAD_BYTES)
    throw new Error('댓글 묶음 전송 크기가 4 MiB를 초과합니다.');
  const thread = `${cfg.destinationId}:${input.root.id}`;
  const previous = await db.threadItems.where('thread').equals(thread).toArray();
  const merged = new Map(previous.map((item) => [item.record.id, item.record]));
  for (const record of [input.root, ...input.replies]) {
    const old = merged.get(record.id);
    merged.set(record.id, { ...old, ...record } as BackupRecord);
  }
  const root = merged.get(input.root.id)!;
  const all = orderThreadReplies(root, [...merged.values()]);
  const replies = all.slice(0, MAX_THREAD_REPLIES).map((reply) => reply.record);
  const limited =
    input.limited ||
    previous.some((item) => item.limited) ||
    all.length > MAX_THREAD_REPLIES ||
    all.length < merged.size - 1;
  const note = await renderThreadNote({ root, replies, limited });
  const key = `${cfg.destinationId}:${note.id}:${note.hash}`;
  // Graph and durable job are committed together before acknowledging the capture.
  await db.transaction('rw', db.jobs, db.threadItems, async () => {
    const existing = await db.jobs.get(key);
    if (!existing && (await db.jobs.where('state').equals('pending').count()) >= 5000)
      throw new Error(
        '백업 대기열이 5,000개에 도달했습니다. 처리 후 기존 데이터를 다시 추가하세요.',
      );
    await db.threadItems.bulkPut(
      [root, ...replies].map((record) => ({
        key: `${thread}:${record.id}`,
        thread,
        record,
        limited: record.id === root.id && limited,
      })),
    );
    if (!existing)
      await db.jobs.add({
        ...note,
        key,
        target: cfg.destinationId,
        state: 'pending',
        modules: ['BookmarksModule'],
        due: 0,
        attempts: 0,
        error: '',
        createdAt: Date.now(),
      });
  });
  return { ok: true, accepted: 1, replies: replies.length, limited };
}

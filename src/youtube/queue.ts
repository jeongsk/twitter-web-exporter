import type { BackupDatabase } from '@/backup/queue';
import type { BackupConfig } from '@/backup/types';
import { isYoutubeVideo } from './model';
import { renderYoutubeNote } from './format';

export const MAX_YOUTUBE_BATCH = 100;

/**
 * Queues one note per liked video. Destination and platform both participate in every key, and an
 * unchanged video (same body hash) is never queued twice. `accepted` counts every valid video in
 * the message, including ones already queued, like the X and Threads handlers.
 */
export async function queueYoutube(db: BackupDatabase, input: unknown, cfg: BackupConfig) {
  if (!cfg.enabled || !cfg.youtubeEnabled) return { ok: true, accepted: 0, paused: true };
  if (!cfg.destinationId) throw new Error('백업 저장 위치를 먼저 연결하세요.');
  if (!Array.isArray(input) || input.length > MAX_YOUTUBE_BATCH || !input.every(isYoutubeVideo))
    throw new Error('YouTube 영상 데이터 형식이나 크기가 올바르지 않습니다.');
  const unique = [...new Map(input.map((video) => [video.id, video])).values()];
  const notes = await Promise.all(unique.map((video) => renderYoutubeNote(video)));
  await db.transaction('rw', db.jobs, async () => {
    let pending = await db.jobs.where('state').equals('pending').count();
    for (const note of notes) {
      const key = `${cfg.destinationId}:youtube:${note.id}:${note.hash}`;
      if (await db.jobs.get(key)) continue;
      if (pending >= 5000)
        throw new Error('백업 대기열이 5,000개에 도달했습니다. 처리 후 다시 수집하세요.');
      await db.jobs.add({
        ...note,
        key,
        target: cfg.destinationId,
        state: 'pending',
        modules: ['YoutubeLikesModule'],
        due: 0,
        attempts: 0,
        error: '',
        createdAt: Date.now(),
      });
      pending++;
    }
  });
  return { ok: true, accepted: input.length };
}

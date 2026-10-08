import logger from '@/utils/logger';
import type { BackupConfig } from '@/backup/types';
import { withTimeout } from '@/backup/connection-errors';
import { runAutoCollect } from '@/backup/auto-collect';
import { extractYoutubeLikes } from '@/youtube/dom';
import { isYoutubeLikes, type YoutubeVideo } from '@/youtube/model';

const CHUNK = 100;
/** id -> JSON of the last version the worker accepted; a changed row is sent again. */
const delivered = new Map<string, string>();
/** Every id rendered at some point, first seen first (YouTube recycles rows while scrolling). */
const seen = new Set<string>();
let busy = false,
  again = false,
  forcePending = false,
  paused = false,
  timer = 0,
  lastUrl = location.href,
  error = '';
/** Rendering mutates constantly; do not ask the worker for settings on every debounced run. */
let cached: { at: number; config: BackupConfig } | null = null;
const CONFIG_TTL = 20000;

async function send(request: Record<string, unknown>) {
  const reply = await withTimeout(
    chrome.runtime.sendMessage(request),
    15000,
    '확장 프로그램 응답이 없습니다. 확장 프로그램과 YouTube 탭을 새로고침하세요.',
    'WORKER_TIMEOUT',
  );
  if (!reply?.ok) throw new Error(reply?.error ?? 'YouTube 백업 요청에 실패했습니다.');
  return reply as { ok: true; accepted?: number; paused?: boolean; config?: BackupConfig };
}
function collect(): YoutubeVideo[] {
  if (!isYoutubeLikes(location.href)) return [];
  const { videos } = extractYoutubeLikes(document);
  for (const video of videos) seen.add(video.id);
  return videos;
}
async function run(force = false) {
  if (busy) {
    again = true;
    forcePending ||= force;
    return;
  }
  busy = true;
  const before = error;
  error = '';
  try {
    if (force) {
      delivered.clear();
      paused = false;
      cached = null;
    }
    const videos = collect();
    if (paused || !videos.length) return;
    const pending = videos.filter((video) => delivered.get(video.id) !== JSON.stringify(video));
    if (!pending.length) return;
    if (!cached || Date.now() - cached.at > CONFIG_TTL) {
      const config = (await send({ type: 'TWE_BACKUP_CONFIG_GET' })).config;
      if (!config) throw new Error('YouTube 백업 설정을 읽지 못했습니다.');
      cached = { at: Date.now(), config };
    }
    const cfg = cached.config;
    if (!cfg.enabled || cfg.youtubeEnabled !== true) return;
    for (let offset = 0; offset < pending.length; offset += CHUNK) {
      const chunk = pending.slice(offset, offset + CHUNK);
      const reply = await send({ type: 'TWE_BACKUP_YOUTUBE', videos: chunk });
      if (reply.paused) {
        paused = true;
        break;
      }
      for (const video of chunk) delivered.set(video.id, JSON.stringify(video));
    }
  } catch (reason) {
    error = reason instanceof Error ? reason.message : 'YouTube 수집 오류';
  } finally {
    busy = false;
    if (error && error !== before) logger.warn(error);
    if (again) {
      again = false;
      const next = forcePending;
      forcePending = false;
      void run(next);
    }
  }
}
function schedule() {
  if (timer || !isYoutubeLikes(location.href)) return;
  timer = window.setTimeout(() => {
    timer = 0;
    void run();
  }, 500);
}
function navigated() {
  lastUrl = location.href;
  schedule();
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  if (msg?.type === 'TWE_BACKUP_REPLAY') {
    void run(true);
    reply({ ok: true });
  }
  if (msg?.type === 'TWE_STATUS')
    reply({
      ready: true,
      source: 'youtube',
      error,
      panelVisible: false,
      counts: { tweets: seen.size, users: 0, captures: seen.size },
    });
});

new MutationObserver(schedule).observe(document.documentElement, {
  subtree: true,
  childList: true,
  characterData: true,
  attributes: true,
  attributeFilter: ['href', 'title', 'hidden'],
});
// yt-navigate-finish bubbles from ytd-app; a window listener also catches window dispatches.
addEventListener('yt-navigate-finish', navigated);
addEventListener('popstate', navigated);
setInterval(() => {
  if (location.href !== lastUrl) navigated();
}, 1000);
schedule();
setTimeout(() => {
  void runAutoCollect(
    async (request) => (await chrome.runtime.sendMessage(request)) ?? {},
    () => {
      collect();
      return [...seen];
    },
  ).catch((reason: unknown) => logger.warn('YouTube 자동 수집 중단', reason));
}, 1500);

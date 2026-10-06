import { createElement, render } from 'preact';
import { signal } from '@preact/signals';
import { liveQuery } from 'dexie';
import { options } from '@/core/options';
import logger from '@/utils/logger';
import { ThreadsPanel } from '@/threads/panel';
import type { ThreadsPanelState } from '@/threads/panel-state';
import { extractThreadsPage } from '@/threads/dom';
import { isThreadsPage, isThreadsSaved, parseThreadsPost } from '@/threads/model';
import { ThreadsSource } from '@/threads/source';
import type { BackupConfig } from '@/backup/types';
import { withTimeout } from '@/backup/connection-errors';
import { runAutoCollect } from '@/backup/auto-collect';

const db = new ThreadsSource();
const delivered = new Map<string, string>();
let busy = false,
  again = false,
  timer = 0,
  lastUrl = location.href;
let savedCount = 0,
  replyCount = 0,
  error = '',
  notice = '',
  queued = 0;
const host = document.createElement('div');
host.id = 'twe-root';
host.dataset.platform = 'threads';
const state = signal<ThreadsPanelState>({
  savedCount: 0,
  replyCount: 0,
  queued: 0,
  busy: false,
  notice: '',
  error: '',
});
const visible = signal(options.get('showControlPanel') !== false);
const settingsOpen = signal(false);
function draw() {
  state.value = { savedCount, replyCount, queued, busy, notice, error };
}
function showError(reason: unknown) {
  error = reason instanceof Error ? reason.message : 'Threads 제어판 오류';
  logger.warn(error);
  draw();
}
function togglePanel() {
  visible.value = !visible.value;
  try {
    options.set('showControlPanel', visible.value);
  } catch (reason) {
    showError(reason);
  }
}
function openBackup() {
  void send({ type: 'TWE_BACKUP_OPEN' }).catch(showError);
}
async function send(request: Record<string, unknown>) {
  const reply = await withTimeout(
    chrome.runtime.sendMessage(request),
    15000,
    '확장 프로그램 응답이 없습니다. 확장 프로그램과 Threads 탭을 새로고침하세요.',
    'WORKER_TIMEOUT',
  );
  if (!reply?.ok) throw new Error(reply?.error ?? 'Threads 백업 요청에 실패했습니다.');
  return reply;
}
async function configuration(): Promise<BackupConfig> {
  return (await send({ type: 'TWE_BACKUP_CONFIG_GET' })).config;
}
async function submit(codes: string[], cfg: BackupConfig, force = false) {
  if (!cfg.enabled || !cfg.threadsEnabled) {
    notice = '백업 설정에서 자동 백업과 Threads 저장 게시물 포함을 켜세요.';
    return;
  }
  for (const code of new Set(codes)) {
    const bundle = await db.bundle(code);
    const signature = JSON.stringify(bundle),
      key = `${cfg.destinationId}:${code}`;
    if (!force && delivered.get(key) === signature) continue;
    const reply = await send({ type: 'TWE_BACKUP_THREADS', bundle });
    if (reply.paused) break;
    delivered.set(key, signature);
    queued++;
  }
  notice = '로드된 게시물을 자동 백업합니다. 처리 결과는 Obsidian 설정에서 확인하세요.';
}
function schedule() {
  if (timer) return;
  timer = window.setTimeout(() => {
    timer = 0;
    void run();
  }, 500);
}
let forcePending = false;
async function run(force = false) {
  if (busy) {
    again = true;
    forcePending ||= force;
    return;
  }
  busy = true;
  const beforeSaved = savedCount,
    beforeQueued = queued,
    beforeError = error;
  error = '';
  draw();
  try {
    const url = location.href,
      saved = isThreadsSaved(url),
      detail = parseThreadsPost(url);
    if (!saved && !detail && !force) {
      notice =
        'Threads 저장 목록을 열어 수집하세요. 홈·프로필에서는 새 게시물을 수집하지 않습니다.';
      return;
    }
    const result = extractThreadsPage(document, url, saved);
    const accepted = saved || detail ? await db.save(result.posts, saved, detail?.code) : 0;
    savedCount = await db.posts.where('saved').equals(1).count();
    replyCount = await db.posts.where('replyTo').above('').count();
    // Read source data even when the backup worker is temporarily unavailable.
    const cfg = await configuration();
    if (force) {
      delivered.clear();
      for (let offset = 0; ; offset += 100) {
        const rows = await db.posts.where('saved').equals(1).offset(offset).limit(100).toArray();
        await submit(
          rows.map((row) => row.code),
          cfg,
          true,
        );
        if (rows.length < 100) break;
      }
    } else if (accepted) {
      await submit(saved ? result.posts.map((post) => post.code) : [detail!.code], cfg);
    }
    if (!accepted)
      notice =
        !saved && !detail
          ? 'Threads 저장 목록을 열어 수집하세요. 홈·프로필에서는 새 게시물을 수집하지 않습니다.'
          : saved
            ? '저장 게시물이 아직 로드되지 않았거나 구조를 인식하지 못했습니다. 로그인 후 천천히 스크롤하고 다시 수집하세요.'
            : '먼저 Threads 저장 목록에서 이 원문을 수집하세요. 다른 게시물은 자동 백업하지 않습니다.';
    if (result.skipped)
      error = `분리되지 않은 게시물 링크 ${result.skipped}개가 있습니다. 원문을 열어 확인하세요.`;
  } catch (reason) {
    error = reason instanceof Error ? reason.message : 'Threads 수집 오류';
  } finally {
    busy = false;
    if (error && error !== beforeError) logger.warn(error);
    if (savedCount !== beforeSaved || queued !== beforeQueued)
      logger.info(`Threads: 저장 게시물 ${savedCount}개, 이번 탭 백업 요청 ${queued}건`);
    draw();
    if (again) {
      again = false;
      const nextForce = forcePending;
      forcePending = false;
      void run(nextForce);
    }
  }
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
      source: 'threads',
      error,
      panelVisible: visible.value,
      replyCount,
      counts: { tweets: savedCount, users: 0, captures: savedCount },
    });
  if (msg?.type === 'TWE_COMMAND' && msg.action === 'toggle-panel') {
    togglePanel();
    reply({ ok: true });
  }
  if (msg?.type === 'TWE_COMMAND' && msg.action === 'open-settings') {
    settingsOpen.value = true;
    reply({ ok: true });
  }
});
let mounted = false;
function boot() {
  if (mounted || !isThreadsPage(location.href)) return;
  mounted = true;
  document.body.append(host);
  render(
    createElement(ThreadsPanel, {
      state,
      visible,
      settingsOpen,
      source: db,
      onToggle: togglePanel,
      onScan: () => {
        void run(true);
      },
      onBackup: openBackup,
      onError: showError,
    }),
    host,
  );
  liveQuery(async () => ({
    saved: await db.posts.where('saved').equals(1).count(),
    replies: await db.posts.where('replyTo').above('').count(),
  })).subscribe({
    next: (counts) => {
      savedCount = counts.saved;
      replyCount = counts.replies;
      draw();
    },
    error: showError,
  });
  logger.info('Threads Web Exporter 제어판 준비 완료');
  new MutationObserver((changes) => {
    const external = changes.some((change) => {
      if (host.contains(change.target)) return false;
      if (change.type === 'childList') {
        const nodes = [...change.addedNodes, ...change.removedNodes];
        if (nodes.length && nodes.every((node) => node === host || host.contains(node)))
          return false;
      }
      return true;
    });
    if (external) schedule();
  }).observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['href', 'dir', 'datetime', 'src'],
  });
  addEventListener('popstate', schedule);
  setInterval(() => {
    if (!host.isConnected && document.body) document.body.append(host);
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      schedule();
    }
  }, 1000);
  void run(true);
  const codes = new Set<string>();
  setTimeout(() => {
    void runAutoCollect(
      async (request) => (await chrome.runtime.sendMessage(request)) ?? {},
      () => {
        // The saved list is virtualized; remember every code that was rendered at some point.
        if (isThreadsSaved(location.href))
          for (const post of extractThreadsPage(document, location.href, true).posts)
            codes.add(post.code);
        return [...codes];
      },
    ).catch((reason: unknown) => logger.warn('Threads 자동 수집 중단', reason));
  }, 1500);
}
if (document.readyState === 'loading')
  document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();

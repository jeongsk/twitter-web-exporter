/** Periodic collection: the worker opens inactive tabs, content scripts scroll and report ids. */
export type AutoPlatform = 'x' | 'threads';
export type AutoStopReason = 'known' | 'exhausted' | 'limit' | 'timeout' | 'error';
export const AUTO_SOURCES: Record<AutoPlatform, string> = {
  x: 'https://x.com/i/bookmarks',
  threads: 'https://www.threads.com/saved',
};
export const AUTO_INTERVALS = [0, 1, 3, 6, 12, 24] as const;
export const DEFAULT_AUTO_INTERVAL = 3;
/** Consecutive steps without any new id before the list is considered exhausted. */
export const AUTO_IDLE_STEPS = 3;
export const AUTO_MAX_STEPS = 30;
export const AUTO_KNOWN_LIMIT = 5000;
export const AUTO_STEP_DELAY = 2500;
export const AUTO_TIMEOUT = 3 * 60 * 1000;

export interface AutoSession {
  platform: AutoPlatform;
  tabId: number;
  startedAt: number;
  /** Snapshot taken before the tab opened; ids queued by this very run are not "known". */
  known: string[];
  seen: string[];
  fresh: number;
  idle: number;
  steps: number;
}
export interface AutoPlatformResult {
  fresh: number;
  reason: AutoStopReason;
}
export interface AutoRunResult {
  startedAt: number;
  finishedAt: number;
  x?: AutoPlatformResult;
  threads?: AutoPlatformResult;
}

export function normalizeInterval(value: unknown): number {
  return (AUTO_INTERVALS as readonly unknown[]).includes(value)
    ? (value as number)
    : DEFAULT_AUTO_INTERVAL;
}

/** Bookmark timeline entries are ordered newest first; tweet ids are decimal strings. */
export function bookmarkIds(responseText: string): string[] {
  return [...responseText.matchAll(/"entryId":"tweet-(\d{1,30})"/g)].map((m) => m[1]!);
}

/** Read already queued/saved ids from job primary keys without loading note bodies. */
export function knownFromJobKeys(keys: string[], platform: AutoPlatform): string[] {
  const ids: string[] = [];
  for (const key of keys) {
    const parts = key.split(':');
    if (platform === 'threads' && parts[1] === 'threads' && /^(?:[0-9a-f]{2})+$/.test(parts[2]!))
      ids.push(
        new TextDecoder().decode(
          new Uint8Array(parts[2]!.match(/../g)!.map((h) => parseInt(h, 16))),
        ),
      );
    if (platform === 'x' && parts.length === 3 && /^\d{1,30}$/.test(parts[1]!)) ids.push(parts[1]!);
  }
  return ids;
}

/**
 * One scroll step. Stop at the first id saved by an earlier run (lists are newest first),
 * after AUTO_IDLE_STEPS steps without new ids, or at the hard step limit.
 */
export function autoStep(
  session: AutoSession,
  ids: string[],
  known: ReadonlySet<string>,
): { session: AutoSession; stop?: AutoStopReason } {
  const seen = new Set(session.seen);
  const added = [...new Set(ids)].filter((id) => !seen.has(id));
  added.forEach((id) => seen.add(id));
  const next: AutoSession = {
    ...session,
    seen: [...seen],
    fresh: session.fresh + added.filter((id) => !known.has(id)).length,
    idle: added.length ? 0 : session.idle + 1,
    steps: session.steps + 1,
  };
  if (added.some((id) => known.has(id))) return { session: next, stop: 'known' };
  if (next.idle >= AUTO_IDLE_STEPS) return { session: next, stop: 'exhausted' };
  if (next.steps >= AUTO_MAX_STEPS) return { session: next, stop: 'limit' };
  return { session: next };
}

/** Newest ids first, bounded so storage stays small. */
export function mergeKnown(previous: string[], seen: string[]): string[] {
  return [...new Set([...seen, ...previous])].slice(0, AUTO_KNOWN_LIMIT);
}

export function describeResult(result: AutoPlatformResult | undefined): string {
  if (!result) return '실행 안 함';
  const reason = {
    known: '기존 항목에서 중단',
    exhausted: '더 불러올 항목 없음',
    limit: '스크롤 한도 도달',
    timeout: '시간 초과',
    error: '오류',
  }[result.reason];
  return `새 항목 ${result.fresh}개 (${reason})`;
}

/** Shared by X and Threads content scripts: report ids, scroll, repeat until told to stop. */
export async function runAutoCollect(
  send: (request: Record<string, unknown>) => Promise<{ auto?: boolean; continue?: boolean }>,
  collectIds: () => string[],
) {
  const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
  if (!(await send({ type: 'TWE_AUTO_HELLO' })).auto) return;
  await sleep(AUTO_STEP_DELAY);
  for (;;) {
    const reply = await send({ type: 'TWE_AUTO_STEP', ids: collectIds() });
    if (!reply.continue) return;
    const root = document.scrollingElement ?? document.documentElement;
    window.scrollTo(0, root.scrollHeight);
    // Hidden tabs skip rendering steps, so dispatch the event lazy lists listen to directly.
    window.dispatchEvent(new Event('scroll'));
    await sleep(AUTO_STEP_DELAY);
  }
}

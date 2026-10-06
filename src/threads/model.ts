import { safeWebUrl } from '@/backup/format';

export const THREADS_HOSTS = new Set([
  'www.threads.com',
  'threads.com',
  'www.threads.net',
  'threads.net',
]);
export const THREADS_SAVED = 'https://www.threads.com/saved';
export type ThreadsPost = {
  code: string;
  url: string;
  author: string;
  text: string;
  published: string;
  links: string[];
  media: { type: 'photo' | 'video'; url: string; alt: string }[];
  truncated: boolean;
  replyTo?: string;
};
export type ThreadsBundle = { root: ThreadsPost; replies: ThreadsPost[]; limited: boolean };
export function isThreadsPage(value: string): boolean {
  try {
    const u = new URL(value);
    return (
      u.protocol === 'https:' &&
      THREADS_HOSTS.has(u.hostname) &&
      !u.port &&
      !u.username &&
      !u.password
    );
  } catch {
    return false;
  }
}
export function isThreadsSaved(value: string): boolean {
  return isThreadsPage(value) && /^\/saved\/?$/.test(new URL(value).pathname);
}
export function parseThreadsPost(value: string, base = THREADS_SAVED) {
  try {
    const u = new URL(value, base);
    if (!isThreadsPage(u.href)) return null;
    const match = /^\/@([a-zA-Z0-9._]{1,30})\/post\/([a-zA-Z0-9_-]{1,32})\/?$/.exec(u.pathname);
    if (!match) return null;
    const author = match[1]!.toLowerCase(),
      code = match[2]!;
    return { author, code, url: `https://www.threads.com/@${author}/post/${code}` };
  } catch {
    return null;
  }
}

/** Encode the case-sensitive post code into a portable lowercase filename. */
export function threadsStorageId(code: string) {
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(code))
    throw new Error('Threads 게시물 코드가 올바르지 않습니다.');
  return [...new TextEncoder().encode(code)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max && !value.includes(String.fromCharCode(0));
export function isThreadsPost(value: unknown): value is ThreadsPost {
  if (!object(value) || !text(value.url, 512)) return false;
  const parsed = parseThreadsPost(value.url);
  return (
    !!parsed &&
    parsed.url === value.url &&
    parsed.code === value.code &&
    parsed.author === value.author &&
    text(value.text, 100000) &&
    text(value.published, 40) &&
    (!value.published ||
      (/^\d{4}-\d\d-\d\dT/.test(value.published) &&
        Number.isFinite(Date.parse(value.published)))) &&
    typeof value.truncated === 'boolean' &&
    (value.replyTo === undefined ||
      (typeof value.replyTo === 'string' && /^[a-zA-Z0-9_-]{1,32}$/.test(value.replyTo))) &&
    Array.isArray(value.links) &&
    value.links.length <= 100 &&
    value.links.every(safeWebUrl) &&
    Array.isArray(value.media) &&
    value.media.length <= 32 &&
    value.media.every(
      (m) =>
        object(m) &&
        (m.type === 'photo' || m.type === 'video') &&
        safeWebUrl(m.url) &&
        text(m.alt, 10000),
    )
  );
}
export function orderedReplies(root: ThreadsPost, records: ThreadsPost[]) {
  const seen = new Set([root.code]);
  const byParent = new Map<string, ThreadsPost[]>();
  for (const r of new Map(records.map((r) => [r.code, r])).values()) {
    if (!r.replyTo || r.code === root.code) continue;
    const list = byParent.get(r.replyTo) ?? [];
    list.push(r);
    byParent.set(r.replyTo, list);
  }
  for (const list of byParent.values())
    list.sort(
      (a, b) => a.published.localeCompare(b.published) || a.code.localeCompare(b.code, 'en'),
    );
  const queue = [{ code: root.code, depth: 0 }];
  const result: { post: ThreadsPost; depth: number }[] = [];
  for (let i = 0; i < queue.length; i++) {
    for (const post of byParent.get(queue[i]!.code) ?? []) {
      if (seen.has(post.code)) continue;
      seen.add(post.code);
      const depth = queue[i]!.depth + 1;
      result.push({ post, depth });
      queue.push({ code: post.code, depth });
    }
  }
  return result;
}
export function isThreadsBundle(value: unknown): value is ThreadsBundle {
  if (
    !object(value) ||
    !isThreadsPost(value.root) ||
    !Array.isArray(value.replies) ||
    value.replies.length > 1000 ||
    !value.replies.every(isThreadsPost) ||
    typeof value.limited !== 'boolean'
  )
    return false;
  return orderedReplies(value.root, value.replies).length === value.replies.length;
}
/** A collapsed card must not erase previously expanded content. */
export function mergeThreadsPost(old: ThreadsPost | undefined, next: ThreadsPost): ThreadsPost {
  if (!old) return next;
  const oldText = old.text.trimEnd(),
    newText = next.text.trimEnd();
  const richer =
    !old.truncated &&
    (next.truncated || (oldText.startsWith(newText) && oldText.length > newText.length));
  return {
    ...old,
    ...next,
    published: next.published || old.published,
    text: richer ? old.text : next.text,
    truncated: richer ? old.truncated : next.truncated,
    links: [...new Set([...old.links, ...next.links])].slice(0, 100),
    media: [...new Map([...old.media, ...next.media].map((m) => [m.url, m])).values()].slice(0, 32),
  };
}

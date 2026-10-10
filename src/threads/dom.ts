import { safeWebUrl } from '@/backup/format';
import {
  isThreadsPost,
  parseThreadsPost,
  isThreadsPage,
  threadsMediaKey,
  type ThreadsPost,
} from './model';

// Independent implementation informed by threadmark's [dir=auto] and sibling-media findings.
const ARTICLE = 'article, [role="article"]';
const EXCLUDED =
  'nav, aside, footer, [role="navigation"], [role="complementary"], [contenteditable="true"], [role="menu"], #twe-root, #twe-threads-panel';
const QUOTE = 'blockquote, [data-quote], [aria-label="Quoted post"], [aria-label="인용한 게시물"]';
const REPLY = /^(replying to|in reply to|답글 대상|회신 대상)/i;
const value = (element: Element) => (element as HTMLElement).innerText ?? element.textContent ?? '';
function visible(element: Element) {
  return !element.closest('[hidden], [aria-hidden="true"]') && element.getClientRects().length > 0;
}
function profileLink(element: Element, base: string) {
  const href = element.getAttribute('href');
  if (!href) return false;
  try {
    const u = new URL(href, base);
    return isThreadsPage(u.href) && /^\/@[a-zA-Z0-9._]+\/?$/.test(u.pathname);
  } catch {
    return false;
  }
}
function replyLink(a: Element) {
  return (
    REPLY.test(a.getAttribute('aria-label') ?? '') ||
    (!!a.closest('[role="note"]') && REPLY.test(value(a.closest('[role="note"]')!).trim()))
  );
}
/** A timestamp permalink can be WRAPPED in dir=auto. That is metadata, not body text. */
function postAnchor(a: HTMLAnchorElement, base: string) {
  if (!parseThreadsPost(a.href, base) || a.closest(EXCLUDED + ', ' + QUOTE) || replyLink(a))
    return false;
  if (a.querySelector('time') || a.closest('time')) return true;
  const wrapper = a.closest('[dir="auto"]');
  if (!wrapper || wrapper === a) return true;
  // Keep a standalone permalink label, but not a post URL embedded in a sentence.
  const remainder = wrapper.cloneNode(true) as Element;
  remainder.querySelectorAll('a[href]').forEach((link) => link.remove());
  return !remainder.textContent?.trim();
}
function ownLinks(scope: Element, base: string) {
  return [...scope.querySelectorAll<HTMLAnchorElement>('a[href]')].filter(
    (a) => postAnchor(a, base) && (!scope.matches(ARTICLE) || a.closest(ARTICLE) === scope),
  );
}
/** Find the smallest metadata row containing this permalink and its matching author label. */
function headerFor(anchor: HTMLAnchorElement, base: string): Element {
  const expected = parseThreadsPost(anchor.href, base)!;
  let parent = anchor.parentElement;
  for (let depth = 0; parent && depth < 20; depth++, parent = parent.parentElement) {
    if (parent.matches('body, main, [role="main"], ' + ARTICLE)) break;
    const authors = [...parent.querySelectorAll<HTMLAnchorElement>('a[href]')].filter((a) => {
      if (!profileLink(a, base) || !value(a).trim()) return false;
      return (
        new URL(a.href, base).pathname.replace(/\/$/, '').toLowerCase() === '/@' + expected.author
      );
    });
    if (authors.length) return parent;
    if (new Set(ownLinks(parent, base).map((a) => parseThreadsPost(a.href, base)!.code)).size > 1)
      break;
  }
  return anchor.closest('[dir="auto"]') ?? anchor;
}
function belongs(element: Element, card: Element) {
  return (
    !element.closest(EXCLUDED + ', ' + QUOTE) &&
    (!card.matches(ARTICLE) || element.closest(ARTICLE) === card)
  );
}
function textParts(card: Element, base: string, header?: Element) {
  const candidates = [...card.querySelectorAll('[dir="auto"]')].filter((el) => {
    if (
      !belongs(el, card) ||
      !visible(el) ||
      (header !== undefined && header.contains(el)) ||
      !!el.querySelector('time') ||
      [...card.querySelectorAll('button, [role="button"], time, [role="toolbar"]')].some(
        (control) => control.contains(el),
      )
    )
      return false;
    const anchor = el.closest('a[href]');
    if (
      anchor &&
      (profileLink(anchor, base) || parseThreadsPost(anchor.getAttribute('href')!, base))
    )
      return false;
    if ([...el.querySelectorAll('a[href]')].some((a) => profileLink(a, base))) return false;
    if (el.querySelector('a[href]') && !value(el).trim()) return false;
    return !!value(el).trim();
  });
  return candidates.filter((el) => !candidates.some((other) => other !== el && other.contains(el)));
}
function mediaParts(card: Element, base: string): ThreadsPost['media'] {
  const result: ThreadsPost['media'] = [];
  for (const el of card.querySelectorAll<HTMLImageElement | HTMLVideoElement>('img, video')) {
    if (!belongs(el, card) || !visible(el)) continue;
    const image = el.tagName === 'IMG';
    const alt = image ? (el as HTMLImageElement).alt : '';
    if (
      image &&
      (/profile (picture|photo)|프로필|ảnh đại diện/i.test(alt) ||
        (el.closest('a[href]') && profileLink(el.closest('a[href]')!, base)))
    )
      continue;
    const src = el.currentSrc || el.src;
    if (safeWebUrl(src)) result.push({ type: image ? 'photo' : 'video', url: src, alt });
  }
  return [...new Map(result.map((m) => [threadsMediaKey(m.url), m])).values()];
}
function findCard(anchor: HTMLAnchorElement, base: string): Element | null {
  const expected = parseThreadsPost(anchor.href, base);
  if (!expected) return null;
  const header = headerFor(anchor, base);
  const semantic = anchor.closest(ARTICLE);
  if (semantic) {
    const codes = new Set(
      ownLinks(semantic, base).map((a) => parseThreadsPost(a.href, base)!.code),
    );
    if (codes.size === 1 && codes.has(expected.code)) return semantic;
    return null;
  }
  let parent = anchor.parentElement;
  for (let depth = 0; parent && depth < 24; depth++, parent = parent.parentElement) {
    if (parent.matches('body, main, [role="main"]')) break;
    const codes = new Set(ownLinks(parent, base).map((a) => parseThreadsPost(a.href, base)!.code));
    if (codes.size > 1) break;
    if (
      codes.has(expected.code) &&
      (textParts(parent, base, header).length || mediaParts(parent, base).length)
    )
      return parent;
  }
  return null;
}
function extractCard(card: Element, anchor: HTMLAnchorElement, base: string): ThreadsPost | null {
  const parsed = parseThreadsPost(anchor.href, base);
  if (!parsed) return null;
  const parts = textParts(card, base, headerFor(anchor, base));
  const text = parts.map((el) => value(el).trim()).join('\n\n');
  const media = mediaParts(card, base);
  const links = [
    ...new Set(
      parts.flatMap((el) =>
        [...el.querySelectorAll<HTMLAnchorElement>('a[href]')]
          .map((a) => a.href)
          .filter((url) => safeWebUrl(url) && !isThreadsPage(url)),
      ),
    ),
  ];
  if (!text && !media.length && !links.length) return null;
  const time =
    anchor.querySelector<HTMLTimeElement>('time[datetime]') ??
    (anchor.closest('time[datetime]') as HTMLTimeElement | null) ??
    headerFor(anchor, base).querySelector<HTMLTimeElement>('time[datetime]');
  const date = new Date(time?.dateTime ?? '');
  const parent = [...card.querySelectorAll<HTMLAnchorElement>('a[href]')]
    .filter((a) => belongs(a, card) && replyLink(a))
    .map((a) => parseThreadsPost(a.href, base))
    .find((p) => p && p.code !== parsed.code);
  const truncated = [...card.querySelectorAll('button, [role="button"], span')].some((el) =>
    /^(see more|read more|더 보기|더보기|계속 읽기)$/i.test(value(el).trim()),
  );
  const result: ThreadsPost = {
    ...parsed,
    text,
    media,
    links,
    truncated,
    published: Number.isFinite(+date) ? date.toISOString() : '',
    ...(parent ? { replyTo: parent.code } : {}),
  };
  return isThreadsPost(result) ? result : null;
}
export function extractThreadsPage(document: Document, base: string, saved: boolean) {
  const scope =
    [...document.querySelectorAll('main, [role="main"]')].find(
      (element) => !element.closest(EXCLUDED),
    ) ?? document.body;
  const posts = new Map<string, ThreadsPost>();
  let candidates = 0,
    skipped = 0;
  const visited = new Set<Element>();
  const failures = new Set<string>();
  for (const anchor of scope.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    if (
      !postAnchor(anchor, base) ||
      !visible(anchor) ||
      anchor.closest(EXCLUDED + ', ' + QUOTE) ||
      replyLink(anchor) ||
      (saved && anchor.closest('[role="dialog"]'))
    )
      continue;
    const card = findCard(anchor, base);
    if (!card) {
      failures.add(parseThreadsPost(anchor.href, base)!.code);
      continue;
    }
    if (saved && card.parentElement?.closest(ARTICLE)) continue;
    if (visited.has(card)) continue;
    visited.add(card);
    candidates++;
    const post = extractCard(card, anchor, base);
    if (!post) {
      failures.add(parseThreadsPost(anchor.href, base)!.code);
      continue;
    }
    if (!posts.has(post.code)) posts.set(post.code, post);
  }
  skipped = [...failures].filter((code) => !posts.has(code)).length;
  return { posts: [...posts.values()], candidates, skipped };
}

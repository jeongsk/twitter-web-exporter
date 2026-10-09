import { safeWebUrl } from '@/backup/format';
import {
  isYoutubePage,
  isYoutubeVideo,
  parseYoutubeVideo,
  youtubeUrl,
  type YoutubeVideo,
} from './model';

const BASE = 'https://www.youtube.com/';
/** Classic playlist rows and the newer lockup layout, in document order. */
const ROW = 'ytd-playlist-video-renderer, yt-lockup-view-model';
/** Inactive SPA pages stay in the DOM with [hidden]; headers link to the first video too. */
const EXCLUDED =
  '[hidden], ytd-playlist-header-renderer, ytd-playlist-sidebar-renderer, yt-page-header-renderer, ytd-miniplayer, #twe-root';
const PLACEHOLDER =
  /^\[(?:private video|deleted video|unavailable video|비공개 동영상|삭제된 동영상|사용할 수 없는 동영상)\]$/i;
const DURATION = /^(?:\d{1,3}(?::\d{2}){1,2})?$/;

const clean = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
const label = (element: Element | null | undefined) =>
  element ? clean(element.getAttribute('title')) || clean(element.textContent) : '';

const listOf = (href: string) => {
  try {
    return new URL(href, BASE).searchParams.get('list');
  } catch {
    return null;
  }
};
/**
 * Whether a row belongs to Liked videos. A row linking into another list (a reused playlist page
 * still showing Watch later, say) is foreign. Lockups also appear outside playlists, so they need
 * an explicit list=LL link; classic playlist rows may only carry a /shorts/ link.
 */
function likedRow(row: Element): boolean {
  const lists = [...row.querySelectorAll('a[href]')]
    .filter((a) => parseYoutubeVideo(a.getAttribute('href')!, BASE))
    .map((a) => listOf(a.getAttribute('href')!));
  if (lists.some((list) => list !== null && list !== 'LL')) return false;
  return row.matches('ytd-playlist-video-renderer') || lists.includes('LL');
}
function videoId(row: Element): string | null {
  for (const a of row.querySelectorAll('a[href]')) {
    const id = parseYoutubeVideo(a.getAttribute('href')!, BASE);
    if (id) return id;
  }
  return null;
}
function channelLink(scope: Element): { channel: string; channelUrl: string } | null {
  const candidates = scope.querySelectorAll<HTMLAnchorElement>(
    'ytd-channel-name a[href], #channel-name a[href], yt-content-metadata-view-model a[href], a[href^="/@"], a[href^="/channel/"], a[href^="/c/"], a[href^="/user/"]',
  );
  for (const a of candidates) {
    let u: URL;
    try {
      u = new URL(a.getAttribute('href')!, BASE);
    } catch {
      continue;
    }
    if (
      !isYoutubePage(u.href) ||
      !/^\/(?:@[^/]+|channel\/[\w-]+|c\/[^/]+|user\/[^/]+)\/?$/.test(u.pathname)
    )
      continue;
    const channel = label(a);
    const channelUrl = `https://www.youtube.com${u.pathname.replace(/\/$/, '')}`;
    if (channel && safeWebUrl(channelUrl)) return { channel, channelUrl };
  }
  return null;
}
/**
 * Collaboration videos list several channels as plain text in the first metadata row (the names
 * open a chooser instead of linking), e.g. "A", verified icon, "및 B". Keep the names without a URL.
 */
function plainChannel(scope: Element): { channel: string; channelUrl: string } | null {
  const row = scope.querySelector('yt-content-metadata-view-model')?.firstElementChild;
  if (!row || row.querySelector('a[href]')) return null;
  const channel = clean(
    [...row.children]
      .filter((part) => !/icon|delimiter/i.test(part.className))
      .map((part) => clean(part.textContent))
      .join(' '),
  );
  return channel ? { channel, channelUrl: '' } : null;
}
function duration(scope: Element): string {
  const badges = scope.querySelectorAll(
    '#text.ytd-thumbnail-overlay-time-status-renderer, ytd-thumbnail-overlay-time-status-renderer, yt-thumbnail-badge-view-model badge-shape, badge-shape',
  );
  for (const badge of badges) {
    const value = clean(badge.textContent);
    if (value && DURATION.test(value)) return value;
  }
  return '';
}
function titleOf(row: Element): string {
  return (
    label(row.querySelector('#video-title')) ||
    label(row.querySelector('h3[title], .yt-lockup-metadata-view-model__title, h3'))
  );
}
function build(id: string, title: string, scope: Element): YoutubeVideo | null {
  if (!title || PLACEHOLDER.test(title)) return null;
  const owner = channelLink(scope) ?? plainChannel(scope);
  if (!owner) return null;
  const video: YoutubeVideo = {
    id,
    url: youtubeUrl(id),
    title: title.slice(0, 1000),
    channel: owner.channel.slice(0, 500),
    channelUrl: owner.channelUrl,
    duration: duration(scope),
  };
  return isYoutubeVideo(video) ? video : null;
}
/** Smallest ancestor of a bare link that also carries a channel link, without a second video. */
function fallbackCard(anchor: Element, id: string): Element | null {
  let parent = anchor.parentElement;
  for (let depth = 0; parent && depth < 8; depth++, parent = parent.parentElement) {
    if (parent.matches('body, #contents, ytd-browse')) break;
    const ids = new Set(
      [...parent.querySelectorAll('a[href]')]
        .map((a) => parseYoutubeVideo(a.getAttribute('href')!, BASE))
        .filter(Boolean),
    );
    if (ids.size > 1) break;
    if (ids.has(id) && channelLink(parent)) return parent;
  }
  return null;
}

/** Liked videos as rendered, newest like first. Rows that cannot be read are counted as skipped. */
export function extractYoutubeLikes(doc: Document): { videos: YoutubeVideo[]; skipped: number } {
  const videos = new Map<string, YoutubeVideo>();
  const failed = new Set<string>();
  let anonymous = 0;
  const fail = (id: string | null) => (id ? failed.add(id) : anonymous++);
  const rows = [...doc.querySelectorAll(ROW)].filter(
    (row) => !row.closest(EXCLUDED) && !row.parentElement?.closest(ROW) && likedRow(row),
  );
  for (const row of rows) {
    const id = videoId(row);
    if (!id) {
      fail(null);
      continue;
    }
    if (videos.has(id)) continue;
    const video = build(id, titleOf(row), row);
    if (video) videos.set(id, video);
    else fail(id);
  }
  if (!rows.length) {
    // Unknown layout: fall back to links into the Liked videos playlist.
    for (const a of doc.querySelectorAll('a[href*="list=LL"]')) {
      if (a.closest(EXCLUDED)) continue;
      const href = a.getAttribute('href')!;
      const id = listOf(href) === 'LL' ? parseYoutubeVideo(href, BASE) : null;
      if (!id || videos.has(id)) continue;
      const card = fallbackCard(a, id);
      // Thumbnail links carry the duration badge as text, so prefer the card's heading.
      const title =
        (card ? titleOf(card) : '') ||
        clean(a.getAttribute('title')) ||
        (a.querySelector('img, badge-shape') ? '' : clean(a.textContent));
      const video = card ? build(id, title, card) : null;
      if (video) videos.set(id, video);
      else if (title) fail(id); // Thumbnail links have no text; only count titled links.
    }
  }
  const skipped = [...failed].filter((id) => !videos.has(id)).length + anonymous;
  return { videos: [...videos.values()], skipped };
}

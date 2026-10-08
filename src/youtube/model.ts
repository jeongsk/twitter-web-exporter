import { safeWebUrl } from '@/backup/format';

export const YOUTUBE_HOSTS = new Set(['www.youtube.com', 'youtube.com', 'm.youtube.com']);
/** The "Liked videos" playlist, newest like first. */
export const YOUTUBE_LIKES = 'https://www.youtube.com/playlist?list=LL';
export type YoutubeVideo = {
  /** 11-character video id. */
  id: string;
  /** Canonical https://www.youtube.com/watch?v=<id>. */
  url: string;
  title: string;
  channel: string;
  /** Channel page URL, or '' when the card has no channel link. */
  channelUrl: string;
  /** Display text such as "12:34", or '' (live streams, shorts, not yet rendered). */
  duration: string;
};
export function isYoutubePage(value: string): boolean {
  try {
    const u = new URL(value);
    return (
      u.protocol === 'https:' &&
      YOUTUBE_HOSTS.has(u.hostname) &&
      !u.port &&
      !u.username &&
      !u.password
    );
  } catch {
    return false;
  }
}
export function isYoutubeLikes(value: string): boolean {
  if (!isYoutubePage(value)) return false;
  const u = new URL(value);
  return u.pathname === '/playlist' && u.searchParams.get('list') === 'LL';
}
export const isYoutubeId = (value: unknown): value is string =>
  typeof value === 'string' && /^[\w-]{11}$/.test(value);
export const youtubeUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;
/** Thumbnails are derived from the id so lazily loaded <img> sources are not needed. */
export const youtubeThumbnail = (id: string) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
/** Video id from a watch, shorts or youtu.be link; null for anything else. */
export function parseYoutubeVideo(value: string, base = YOUTUBE_LIKES): string | null {
  try {
    const u = new URL(value, base);
    if (u.protocol !== 'https:') return null;
    let id: string | null | undefined;
    if (u.hostname === 'youtu.be') id = u.pathname.slice(1);
    else if (!isYoutubePage(u.href)) return null;
    else if (u.pathname === '/watch') id = u.searchParams.get('v');
    else id = /^\/shorts\/([\w-]{11})\/?$/.exec(u.pathname)?.[1];
    return isYoutubeId(id) ? id : null;
  } catch {
    return null;
  }
}
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max && !value.includes(String.fromCharCode(0));
export function isYoutubeVideo(value: unknown): value is YoutubeVideo {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    isYoutubeId(v.id) &&
    v.url === youtubeUrl(v.id) &&
    text(v.title, 1000) &&
    v.title.trim() !== '' &&
    text(v.channel, 500) &&
    text(v.channelUrl, 512) &&
    (v.channelUrl === '' || (safeWebUrl(v.channelUrl) && isYoutubePage(v.channelUrl))) &&
    text(v.duration, 20) &&
    /^(?:\d{1,3}(?::\d{2}){1,2})?$/.test(v.duration)
  );
}

/** Shared, unprivileged MAIN <-> ISOLATED message contract. Never carry headers or cookies. */
export const CHANNEL = 'twitter-web-exporter:chrome:v1';
export const MAX_RESPONSE_CHARS = 8 * 1024 * 1024;
export const MAX_BUFFER_CHARS = 16 * 1024 * 1024;
export const X_HOSTS = new Set(['x.com', 'twitter.com', 'mobile.x.com']);
const OPERATIONS = new Set([
  'Bookmarks',
  'Likes',
  'Followers',
  'BlueVerifiedFollowers',
  'Following',
  'UserByScreenName',
  'AboutAccountQuery',
  'UserTweets',
  'UserTweetsAndReplies',
  'UserOriginalsTimeline',
  'UserRepliesTimeline',
  'UserRepostsTimeline',
  'UserHighlightsTweets',
  'UserMedia',
  'UserPhotoTimeline',
  'UserVideoTimeline',
  'HomeTimeline',
  'HomeLatestTimeline',
  'ListMembers',
  'ListSubscribers',
  'ListLatestTweetsTimeline',
  'Retweeters',
  'CommunityTweetsTimeline',
  'CommunityMediaTimeline',
  'membersSliceTimeline_Query',
  'moderatorsSliceTimeline_Query',
  'SearchTimeline',
  'TweetDetail',
  'ModeratedTimeline',
]);

export interface CapturePacket {
  channel: typeof CHANNEL;
  type: 'response';
  url: string;
  method: string;
  status: number;
  responseText: string;
  accountId: string;
}

export function isXPage(input: string): boolean {
  try {
    const url = new URL(input);
    return url.protocol === 'https:' && X_HOSTS.has(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** A positive list excludes authentication, mutations, analytics, and unrelated API traffic. */
export function isCaptureUrl(input: string): boolean {
  if (!isXPage(input)) return false;
  const path = new URL(input).pathname;
  const match = /^\/i\/api\/graphql\/[^/]+\/([^/]+)$/.exec(path);
  if (match) return OPERATIONS.has(match[1] ?? '');
  return /^\/i\/api\/1\.1\/dm\/(inbox_initial_state\.json|inbox_timeline\/trusted\.json|conversation\/\d+(?:-\d+)?\.json)$/.test(
    path,
  );
}

export function normalizeAccountId(value: unknown): string {
  return typeof value === 'string' && /^\d{1,30}$/.test(value) ? value : 'unknown';
}

export function isCapturePacket(value: unknown): value is CapturePacket {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  return (
    p.channel === CHANNEL &&
    p.type === 'response' &&
    typeof p.url === 'string' &&
    p.url.length <= 16384 &&
    isCaptureUrl(p.url) &&
    (p.method === 'GET' || p.method === 'POST') &&
    typeof p.status === 'number' &&
    Number.isInteger(p.status) &&
    p.status >= 200 &&
    p.status < 300 &&
    typeof p.responseText === 'string' &&
    p.responseText.length <= MAX_RESPONSE_CHARS &&
    typeof p.accountId === 'string' &&
    (p.accountId === 'unknown' || normalizeAccountId(p.accountId) === p.accountId)
  );
}

import type { Tweet } from '@/types';
import {
  extractQuotedTweet,
  extractRetweetedTweet,
  extractTweetFullText,
  extractTweetMedia,
  getMediaOriginalUrl,
} from '@/utils/api';
import { isBackupRecord, safeWebUrl } from './format';
import type { BackupRecord } from './types';

export function captureRecord(tweet: Tweet): BackupRecord | null {
  const user = tweet.core?.user_results?.result?.core;
  const published = new Date(tweet.legacy?.created_at ?? '');
  const related: BackupRecord['related'] = [];
  for (const [kind, source] of [
    ['repost', extractRetweetedTweet(tweet)],
    ['quote', extractQuotedTweet(tweet)],
  ] as const) {
    if (source)
      related.push({
        id: source.rest_id,
        screenName: source.core?.user_results?.result?.core?.screen_name ?? '',
        text: extractTweetFullText(source) ?? '',
        kind,
      });
  }
  const record: BackupRecord = {
    id: tweet.rest_id,
    text: extractTweetFullText(tweet) ?? '',
    screenName: user?.screen_name ?? '',
    name: user?.name ?? '',
    published: Number.isFinite(+published) ? published.toISOString() : '',
    links: (tweet.legacy?.entities?.urls ?? []).map((x) => x.expanded_url).filter(safeWebUrl),
    media: extractTweetMedia(tweet).map((m) => ({
      type: m.type,
      url: getMediaOriginalUrl(m),
      alt: m.ext_alt_text ?? '',
    })),
    related,
    ...(tweet.legacy?.in_reply_to_status_id_str
      ? { replyTo: tweet.legacy.in_reply_to_status_id_str }
      : {}),
    ...(tweet.legacy?.conversation_id_str
      ? { conversationId: tweet.legacy.conversation_id_str }
      : {}),
  };
  return isBackupRecord(record) ? record : null;
}

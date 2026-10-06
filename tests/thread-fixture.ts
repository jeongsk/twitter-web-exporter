import type { Tweet } from '../src/types';
import type { BackupRecord } from '../src/backup/types';
import { fixture } from './fixture';

export function threadRecord(id: string, replyTo?: string, conversationId = '1001'): BackupRecord {
  return {
    id,
    replyTo,
    conversationId,
    text: `댓글 본문 ${id}`,
    screenName: 'thread_user',
    name: '댓글 작성자',
    published: '2026-09-23T05:00:00.000Z',
    links: [],
    media: [],
    related: [],
  };
}
export function threadTweet(id: string, replyTo?: string, conversationId = '1001'): Tweet {
  const value =
    fixture(id).data.bookmark_timeline_v2.timeline.instructions[0]!.entries[0]!.content.itemContent
      .tweet_results.result;
  return {
    ...value,
    legacy: {
      ...value.legacy,
      conversation_id_str: conversationId,
      in_reply_to_status_id_str: replyTo,
      full_text: `댓글 본문 ${id}`,
    },
  } as unknown as Tweet;
}
export const tweetContent = (tweet: Tweet) => ({
  __typename: 'TimelineTweet',
  tweet_results: { result: tweet },
});
export function detailResponse(tweets: Tweet[]) {
  return {
    data: {
      threaded_conversation_with_injections_v2: {
        instructions: [
          {
            type: 'TimelineAddEntries',
            entries: [
              {
                entryId: 'conversationthread-fixture',
                sortIndex: '9999',
                content: {
                  entryType: 'TimelineTimelineModule',
                  items: tweets.map((tweet) => ({
                    entryId: `conversationthread-fixture-tweet-${tweet.rest_id}`,
                    item: { itemContent: tweetContent(tweet) },
                  })),
                },
              },
            ],
          },
        ],
      },
    },
  };
}

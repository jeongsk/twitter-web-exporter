import type { TimelineTweet, Tweet, WithSortIndex } from '@/types';
import { extractTimelineTweet } from '@/utils/api';

type Item = { entryId?: string; item?: { itemContent?: TimelineTweet } };
type Instruction = {
  type: string;
  moduleEntryId?: string;
  moduleItems?: Item[];
  entries?: {
    entryId?: string;
    sortIndex?: string;
    content?: {
      entryType?: string;
      itemContent?: TimelineTweet;
      items?: Item[];
    };
  }[];
};
export function extractTweetDetail(instructions: unknown): WithSortIndex<Tweet>[] {
  if (!Array.isArray(instructions)) throw new Error('Tweet detail instructions are missing.');
  const tweets = new Map<string, WithSortIndex<Tweet>>();
  const add = (content: TimelineTweet | undefined, sortIndex?: string) => {
    // A pagination cursor may share the moduleItems array with actual replies.
    if (!content || content.__typename !== 'TimelineTweet') return;
    const tweet = extractTimelineTweet(content);
    if (tweet) tweets.set(tweet.rest_id, { data: tweet, sortIndex });
  };
  for (const instruction of instructions as Instruction[]) {
    if (instruction?.type === 'TimelineAddEntries') {
      for (const entry of instruction.entries ?? []) {
        const content = entry.content;
        if (content?.entryType === 'TimelineTimelineItem' && entry.entryId?.startsWith('tweet-'))
          add(content.itemContent, entry.sortIndex);
        if (
          content?.entryType === 'TimelineTimelineModule' &&
          entry.entryId?.startsWith('conversationthread-')
        ) {
          for (const item of content.items ?? []) add(item.item?.itemContent, entry.sortIndex);
        }
      }
    }
    if (
      instruction?.type === 'TimelineAddToModule' &&
      instruction.moduleEntryId?.startsWith('conversationthread-')
    ) {
      for (const item of instruction.moduleItems ?? []) add(item.item?.itemContent);
    }
  }
  return [...tweets.values()];
}

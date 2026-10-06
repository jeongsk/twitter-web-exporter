import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { orderThreadReplies, isThreadBackup, renderThreadNote } from '../src/backup/thread';
import {
  findBookmarkedRoots,
  collectBookmarkedThread,
  type ThreadSource,
} from '../src/backup/thread-source';
import { extractTweetDetail } from '../src/modules/tweet-detail/extract';
import { threadRecord as rec, threadTweet as tw, tweetContent } from './thread-fixture';
import type { Tweet } from '../src/types';

function source(tweets: Tweet[], bookmarks = ['1001']) {
  const data = new Map(tweets.map((t) => [t.rest_id, t]));
  const api: ThreadSource = {
    getBackupTweets: async (ids) => ids.map((id) => data.get(id)).filter((t): t is Tweet => !!t),
    getBookmarkedBackupIds: async (ids) => ids.filter((id) => bookmarks.includes(id)),
    getBackupChildren: async (ids, limit) =>
      [...data.values()]
        .filter((t) => ids.includes(t.legacy.in_reply_to_status_id_str ?? ''))
        .slice(0, limit),
  };
  return { data, api };
}
test('bundles nested replies deterministically and excludes siblings and unrelated conversations', () => {
  const root = rec('1001');
  const replies = [
    rec('1020', '1010'),
    rec('1011', '1001'),
    rec('1010', '1001'),
    rec('2001', '2000', '2000'),
  ];
  expect(orderThreadReplies(root, replies).map((r) => [r.record.id, r.depth])).toEqual([
    ['1010', 1],
    ['1011', 1],
    ['1020', 2],
  ]);
  expect(orderThreadReplies(rec('1010', '1001'), replies).map((r) => r.record.id)).toEqual([
    '1020',
  ]);
  expect(isThreadBackup({ root, replies, limited: false })).toBe(false);
  expect(isThreadBackup({ root, replies: [rec('1010', '1001', '9999')], limited: false })).toBe(
    false,
  );
});
test('one Markdown contains root, parents, media and explicit partial coverage', async () => {
  const root = rec('1001');
  const child = {
    ...rec('1010', '1001'),
    text: '첫 번째 댓글\n둘째 줄',
    media: [{ type: 'photo', url: 'https://pbs.twimg.com/media/test.jpg', alt: '댓글 사진' }],
  };
  const replies = [rec('1020', '1010'), child];
  const a = await renderThreadNote({ root, replies, limited: false }, new Date('2026-09-23'));
  const b = await renderThreadNote(
    { root, replies: [...replies].reverse(), limited: false },
    new Date('2026-09-24'),
  );
  expect(a.hash).toBe(b.hash);
  expect(a.markdown).toContain('## 북마크 원문');
  expect(a.markdown).toContain('대댓글');
  expect(a.markdown).toContain('replies_captured: 2');
  expect(a.markdown).toContain('replies_complete: false');
  expect(a.markdown).toContain('https://x.com/thread_user/status/1010');
  expect(a.markdown).toContain('https://pbs.twimg.com/media/test.jpg');
  const body = a.markdown.split('\n---\n').slice(1).join('\n---\n');
  expect(a.hash).toBe(createHash('sha256').update(body).digest('hex'));
});
test('zero loaded replies never claims a complete or empty discussion', async () => {
  const note = await renderThreadNote({ root: rec('1001'), replies: [], limited: false });
  expect(note.markdown).toContain('아직 연결된 댓글을 수집하지 않았습니다.');
  expect(note.markdown).toContain('replies_complete: false');
  expect(
    isThreadBackup({
      root: rec('1001'),
      replies: [rec('1010', '1001'), rec('1010', '1001')],
      limited: false,
    }),
  ).toBe(false);
});
test('comments captured before their parent are attached after the missing parent arrives', async () => {
  const { api, data } = source([tw('1001'), tw('1020', '1010')]);
  expect(await findBookmarkedRoots(api, [tw('1020', '1010')])).toEqual(['1001']);
  expect((await collectBookmarkedThread(api, '1001')).replies).toHaveLength(0);
  data.set('1010', tw('1010', '1001'));
  expect(await findBookmarkedRoots(api, [tw('1010', '1001')])).toContain('1001');
  expect((await collectBookmarkedThread(api, '1001')).replies.map((r) => r.id)).toEqual([
    '1010',
    '1020',
  ]);
});
test('a bookmarked middle reply includes only its descendants, not the whole conversation', async () => {
  const tweets = [tw('1001'), tw('1010', '1001'), tw('1011', '1001'), tw('1020', '1010')];
  const { api } = source(tweets, ['1010']);
  expect(await findBookmarkedRoots(api, [tw('1020', '1010')])).toEqual(['1010']);
  expect((await collectBookmarkedThread(api, '1010')).replies.map((r) => r.id)).toEqual(['1020']);
  expect(await findBookmarkedRoots(api, [tw('1011', '1001')])).toEqual([]);
});
test('size limits are explicit and known replies are not silently marked complete', async () => {
  const { api } = source([
    tw('1001'),
    ...Array.from({ length: 1001 }, (_, i) => tw(String(2000 + i), '1001')),
  ]);
  const bundle = await collectBookmarkedThread(api, '1001');
  expect(bundle.replies).toHaveLength(1000);
  expect(bundle.limited).toBe(true);
  expect((await renderThreadNote(bundle)).markdown).toContain(
    '일부 댓글이 이 파일에 포함되지 않았습니다.',
  );
});
test('detail extraction handles multiple pages and mixed cursor items without dropping later replies', () => {
  const entry = (id: string) => ({
    entryId: `tweet-${id}`,
    sortIndex: id,
    content: { entryType: 'TimelineTimelineItem', itemContent: tweetContent(tw(id)) },
  });
  const item = (id: string) => ({
    entryId: `conversationthread-a-tweet-${id}`,
    item: { itemContent: tweetContent(tw(id, '1001')) },
  });
  const cursor = {
    entryId: 'conversationthread-a-cursor-showmore-1',
    item: { itemContent: { __typename: 'TimelineTimelineCursor' } },
  };
  const instructions = [
    { type: 'TimelineAddEntries', entries: [entry('1001')] },
    {
      type: 'TimelineAddEntries',
      entries: [
        {
          entryId: 'conversationthread-a',
          sortIndex: '5',
          content: { entryType: 'TimelineTimelineModule', items: [item('1010'), cursor] },
        },
      ],
    },
    {
      type: 'TimelineAddToModule',
      moduleEntryId: 'conversationthread-a',
      moduleItems: [cursor, item('1011')],
    },
    {
      type: 'TimelineAddToModule',
      moduleEntryId: 'conversationthread-a',
      moduleItems: [item('1012')],
    },
    {
      type: 'TimelineAddToModule',
      moduleEntryId: 'tweetdetailrelatedtweets-a',
      moduleItems: [item('9999')],
    },
  ];
  expect(extractTweetDetail(instructions).map((t) => t.data.rest_id)).toEqual([
    '1001',
    '1010',
    '1011',
    '1012',
  ]);
});

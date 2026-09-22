export const endpoint = 'https://x.com/i/api/graphql/fixture/Bookmarks';
export function fixture(id: string) {
  const tweet = {
    __typename: 'Tweet',
    rest_id: id,
    core: {
      user_results: {
        result: {
          __typename: 'User',
          rest_id: '42',
          core: {
            name: '테스트 사용자',
            screen_name: 'fixture_user',
            created_at: 'Mon Sep 21 10:00:00 +0000 2026',
          },
          avatar: { image_url: 'https://pbs.twimg.com/profile_images/fixture.png' },
          legacy: { followers_count: 1, friends_count: 1, statuses_count: 2 },
        },
      },
    },
    legacy: {
      id_str: id,
      full_text: `한글 확장 프로그램 테스트 ${id}`,
      created_at: 'Mon Sep 21 10:00:00 +0000 2026',
      favorite_count: 3,
      retweet_count: 1,
      bookmark_count: 2,
      quote_count: 0,
      reply_count: 0,
      entities: { urls: [], media: [] },
      extended_entities: { media: [] },
      bookmarked: true,
    },
    views: { count: '10' },
  };
  return {
    data: {
      bookmark_timeline_v2: {
        timeline: {
          instructions: [
            {
              type: 'TimelineAddEntries',
              entries: [
                {
                  entryId: `tweet-${id}`,
                  sortIndex: id,
                  content: {
                    entryType: 'TimelineTimelineItem',
                    itemContent: {
                      __typename: 'TimelineTweet',
                      tweet_results: { result: tweet },
                    },
                  },
                },
              ],
            },
          ],
        },
      },
    },
  };
}

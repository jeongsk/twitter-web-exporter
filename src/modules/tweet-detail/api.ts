import { Interceptor } from '@/core/extensions';
import { db } from '@/core/database';
import type { TimelineInstructions } from '@/types';
import { extractTweetDetail } from './extract';
import logger from '@/utils/logger';

interface TweetDetailResponse {
  data: {
    threaded_conversation_with_injections_v2: {
      instructions: TimelineInstructions;
    };
  };
}

interface ModeratedTimelineResponse {
  data: {
    tweet: {
      result: {
        timeline_response: {
          timeline: {
            instructions: TimelineInstructions;
          };
        };
      };
    };
  };
}

// https://twitter.com/i/api/graphql/8sK2MBRZY9z-fgmdNpR3LA/TweetDetail
// https://twitter.com/i/api/graphql/a8M2LqEB5TwbW_eDrsmcDA/ModeratedTimeline
export const TweetDetailInterceptor: Interceptor = (req, res, ext) => {
  const isTweetDetail = /\/graphql\/.+\/TweetDetail/.test(req.url);
  const isModeratedTimeline = /\/graphql\/.+\/ModeratedTimeline/.test(req.url);

  if (!isTweetDetail && !isModeratedTimeline) {
    return;
  }

  try {
    const json: TweetDetailResponse | ModeratedTimelineResponse = JSON.parse(res.responseText);
    let instructions: TimelineInstructions = [];

    // Determine the endpoint and extract instructions accordingly.
    if (isTweetDetail) {
      instructions = (json as TweetDetailResponse).data.threaded_conversation_with_injections_v2
        .instructions;
    } else if (isModeratedTimeline) {
      instructions = (json as ModeratedTimelineResponse).data.tweet.result.timeline_response
        .timeline.instructions;
    }

    const newData = extractTweetDetail(instructions);

    // Add captured tweets to the database.
    db.extAddTweets(ext.name, newData);

    logger.info(`TweetDetail: ${newData.length} items received`);
  } catch (err) {
    logger.debug(req.method, req.url, res.status, res.responseText);
    logger.errorWithBanner('TweetDetail: Failed to parse API response', err as Error);
  }
};

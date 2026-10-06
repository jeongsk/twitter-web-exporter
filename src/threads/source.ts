import Dexie, { type Table } from 'dexie';
import type { ThreadsPanelView } from './panel-state';
import {
  isThreadsPost,
  mergeThreadsPost,
  orderedReplies,
  type ThreadsPost,
  type ThreadsBundle,
} from './model';

interface SourceRow {
  code: string;
  saved: number;
  post: ThreadsPost;
  replyTo: string;
}
/** Threads-origin source cache. API credentials are never stored here. */
export class ThreadsSource extends Dexie {
  posts!: Table<SourceRow, string>;
  constructor() {
    super('twitter-web-exporter-threads-source');
    this.version(1).stores({ posts: 'code,saved,replyTo' });
  }
  async listPanelPosts(view: ThreadsPanelView, search = '', offset = 0, limit = 25) {
    const term = search.trim().toLocaleLowerCase();
    const collection = (
      view === 'saved' ? this.posts.where('saved').equals(1) : this.posts.where('replyTo').above('')
    ).filter(
      (row) =>
        isThreadsPost(row.post) &&
        (!term ||
          [row.post.author, row.post.text, row.code].some((value) =>
            value.toLocaleLowerCase().includes(term),
          )),
    );
    return this.transaction('r', this.posts, async () => ({
      count: await collection.clone().count(),
      posts: (await collection.clone().offset(offset).limit(limit).toArray()).map(
        (row) => row.post,
      ),
    }));
  }
  async save(observations: ThreadsPost[], savedPage: boolean, detailCode?: string) {
    let accepted = observations;
    if (!savedPage) {
      const known = detailCode ? await this.posts.get(detailCode) : undefined;
      if (!known?.saved) return 0;
      const root = observations.find((p) => p.code === detailCode) ?? known.post;
      const existing = await this.bundle(detailCode!);
      accepted = [
        root,
        ...orderedReplies(root, [...existing.replies, ...observations]).map((r) => r.post),
      ];
    }
    await this.transaction('rw', this.posts, async () => {
      for (const next of accepted) {
        const old = await this.posts.get(next.code);
        if (!old && (await this.posts.count()) >= 10000)
          throw new Error('Threads 수집 한도가 10,000개에 도달했습니다.');
        const post = mergeThreadsPost(old?.post, next);
        await this.posts.put({
          code: post.code,
          saved: savedPage ? 1 : (old?.saved ?? 0),
          replyTo: post.replyTo ?? '',
          post,
        });
      }
    });
    return accepted.length;
  }
  async bundle(code: string): Promise<ThreadsBundle> {
    const row = await this.posts.get(code);
    if (!row?.saved) throw new Error('저장 목록에서 수집한 Threads 원문이 아닙니다.');
    const seen = new Set([code]);
    const replies: ThreadsPost[] = [];
    let frontier = [code],
      limited = false;
    while (frontier.length) {
      const remaining = 1000 - replies.length;
      const children = await this.posts
        .where('replyTo')
        .anyOf(frontier)
        .limit(remaining + 1)
        .toArray();
      if (children.length > remaining) limited = true;
      frontier = [];
      for (const child of children.slice(0, remaining)) {
        if (seen.has(child.code)) continue;
        seen.add(child.code);
        replies.push(child.post);
        frontier.push(child.code);
      }
      if (limited) break;
    }
    return { root: row.post, replies, limited };
  }
}

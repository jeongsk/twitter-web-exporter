import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  parseThreadsPost,
  isThreadsPage,
  isThreadsSaved,
  isThreadsBundle,
  threadsStorageId,
  mergeThreadsPost,
  orderedReplies,
  threadsMediaKey,
  type ThreadsPost,
} from '../src/threads/model';
import { renderThreadsNote } from '../src/threads/format';
import { ObsidianRestClient, apiDestination } from '../src/backup/rest';
import type { BackupJob } from '../src/backup/queue';
import { threadsSample as sample } from './threads-fixture';

test('Threads canonical URLs preserve post codes and normalize the old domain', () => {
  expect(parseThreadsPost('https://www.threads.net/@Writer.One/post/Case_A1?x=1#top')).toEqual({
    code: sample.code,
    author: sample.author,
    url: sample.url,
  });
  expect(isThreadsSaved('https://www.threads.com/saved?foo=1')).toBe(true);
  expect(isThreadsPage('https://example.org/saved')).toBe(false);
  expect(isThreadsPage('http://www.threads.com/saved')).toBe(false);
  expect(parseThreadsPost('https://www.threads.com/@user/not-a-post/abc')).toBeNull();
});
test('Threads filenames preserve shortcode case on case-insensitive filesystems', () => {
  const upper = threadsStorageId('Ab_1'),
    lower = threadsStorageId('ab_1');
  expect(upper).not.toBe(lower);
  expect(upper).toMatch(/^[a-f0-9]+$/);
  expect(Buffer.from(upper, 'hex').toString('utf8')).toBe('Ab_1');
});
test('Threads Markdown retains short posts, source attribution and stable body hashes', async () => {
  const bundle = { root: sample, replies: [], limited: false };
  const one = await renderThreadsNote(bundle, new Date('2026-09-23T00:00:00Z'));
  const two = await renderThreadsNote(bundle, new Date('2026-09-24T00:00:00Z'));
  expect(one.markdown).toContain('> 좋아요');
  expect(one.markdown).toContain('source_platform: "threads"');
  expect(one.markdown).toContain('source_id: "Case_A1"');
  expect(one.markdown).toContain('replies_complete: false');
  expect(one.hash).toBe(two.hash);
  const body = one.markdown.slice(one.markdown.indexOf('\n---\n', 4) + 5);
  expect(one.hash).toBe(createHash('sha256').update(body).digest('hex'));
});
test('A collapsed saved-list card cannot erase expanded detail text or media', () => {
  const expanded = { ...sample, text: '좋아요. 더 긴 원문을 펼쳐 읽습니다.' };
  const collapsed = { ...sample, truncated: true };
  expect(mergeThreadsPost(expanded, collapsed).text).toBe(expanded.text);
  expect(mergeThreadsPost(collapsed, expanded).truncated).toBe(false);
});
test('Only replies with a parent chain to the saved root are bundled', () => {
  const reply = {
    ...sample,
    code: 'Reply',
    url: sample.url.replace('Case_A1', 'Reply'),
    replyTo: sample.code,
  };
  const nested = {
    ...reply,
    code: 'Nested',
    url: sample.url.replace('Case_A1', 'Nested'),
    replyTo: 'Reply',
  };
  const unrelated = { ...reply, code: 'Other', replyTo: 'AnotherRoot' };
  expect(orderedReplies(sample, [nested, unrelated, reply]).map((r) => r.post.code)).toEqual([
    'Reply',
    'Nested',
  ]);
  expect(isThreadsBundle({ root: sample, replies: [reply, nested], limited: false })).toBe(true);
  expect(isThreadsBundle({ root: sample, replies: [unrelated], limited: false })).toBe(false);
});
test('REST writes Threads to separate paths and preserves originals when content changes', async () => {
  const settings = {
    endpoint: 'http://127.0.0.1:27123',
    folder: 'raw/articles/test',
    apiKey: 'synthetic-threads-unit-key',
  };
  const files = new Map<string, string>();
  let writes = 0;
  const client = new ObsidianRestClient(settings, async (input, options) => {
    const path = new URL(String(input)).pathname;
    if (options?.method === 'PUT') {
      writes++;
      files.set(path, String(options.body));
      return new Response(null, { status: 204 });
    }
    return files.has(path) ? new Response(files.get(path)) : new Response(null, { status: 404 });
  });
  const makeJob = async (text: string): Promise<BackupJob> => {
    const note = await renderThreadsNote({
      root: { ...sample, text },
      replies: [],
      limited: false,
    });
    return {
      ...note,
      key: note.hash,
      target: await apiDestination(settings),
      state: 'pending',
      modules: ['ThreadsSavedModule'],
      due: 0,
      attempts: 0,
      error: '',
      createdAt: 0,
    };
  };
  const first = await makeJob('첫 번째 내용');
  const path = (await client.write(first)).path;
  expect(path).toBe(`raw/articles/test/threads/threads-${threadsStorageId(sample.code)}.md`);
  expect((await client.write(first)).result).toBe('existing');
  expect(writes).toBe(1);
  expect((await client.write(await makeJob('수정된 내용'))).path).toContain('/threads/revisions/');
  expect(files.get('/vault/' + path)).toContain('첫 번째 내용');
  expect(writes).toBe(2);
});
// The same files as Meta serves them on two loads: re-signed (oh, oe, _nc_gid), another size
// variant (stp) and another edge host.
const photo = (host: string, stp: string, sig: string) =>
  `https://${host}.cdninstagram.com/v/t51.82787-15/838947815_1794_n.jpg?stp=${stp}&_nc_cat=105&_nc_gid=${sig}&oh=00_${sig}&oe=6ACEB75F`;
const preview = (host: string, sig: string) =>
  `https://${host}.xx.fbcdn.net/emg1/v/t13/8111502881926058504?url=https%3A%2F%2Fopengraph.githubassets.com%2Fabc%2Frepo&stp=dst-src&_nc_gid=${sig}&oh=06_${sig}`;
const withMedia = (urls: string[], text = sample.text): ThreadsPost => ({
  ...sample,
  text,
  media: urls.map((url) => ({ type: 'photo' as const, url, alt: 'Photo by writer.one.' })),
});
const firstLoad = [
  photo('scontent-icn2-1', 'dst-jpg_e35_tt6', 'Aa1'),
  preview('external-icn2-1', 'Aa1'),
];
const secondLoad = [
  photo('scontent-nrt1-1', 'dst-jpg_e35_p240x240_tt6', 'Bb2'),
  preview('external-nrt1-1', 'Bb2'),
];
test('Re-signed Meta CDN media URLs keep one identity; other URLs are their own', () => {
  expect(threadsMediaKey(firstLoad[0])).toBe(threadsMediaKey(secondLoad[0]));
  expect(threadsMediaKey(firstLoad[1])).toBe(threadsMediaKey(secondLoad[1]));
  expect(threadsMediaKey(firstLoad[1])).toBe('https://opengraph.githubassets.com/abc/repo');
  expect(threadsMediaKey(firstLoad[0])).not.toBe(
    threadsMediaKey(firstLoad[0].replace('838947815_1794', '838947816_1795')),
  );
  expect(threadsMediaKey('https://cdn.example/a.jpg?v=1')).toBe('https://cdn.example/a.jpg?v=1');
  expect(threadsMediaKey('https://cdninstagram.com.evil.example/a.jpg?oh=1')).toBe(
    'https://cdninstagram.com.evil.example/a.jpg?oh=1',
  );
});
test('Re-collecting a post does not append the same media again', () => {
  const merged = mergeThreadsPost(withMedia(firstLoad), withMedia(secondLoad));
  expect(merged.media).toHaveLength(2);
  // Duplicates stored by earlier versions collapse on the next collection.
  const stored = withMedia([...firstLoad, ...secondLoad, firstLoad[0], secondLoad[0]]);
  expect(mergeThreadsPost(stored, withMedia(secondLoad)).media).toHaveLength(2);
  // A different file is still added.
  const other = photo('scontent-icn2-1', 'dst-jpg_e35_tt6', 'Cc3').replace(
    '838947815',
    '900000001',
  );
  expect(mergeThreadsPost(withMedia(firstLoad), withMedia([other])).media).toHaveLength(3);
});
test('Threads hash compares content, not re-signed media URLs', async () => {
  const note = (post: ThreadsPost) =>
    renderThreadsNote({ root: post, replies: [], limited: false });
  const one = await note(withMedia(firstLoad));
  expect((await note(withMedia(secondLoad))).hash).toBe(one.hash);
  expect((await note(withMedia(firstLoad, '본문이 바뀜'))).hash).not.toBe(one.hash);
  expect((await note(withMedia(firstLoad.slice(0, 1)))).hash).not.toBe(one.hash);
  const other = firstLoad[0].replace('838947815', '900000001');
  expect((await note(withMedia([other, firstLoad[1]]))).hash).not.toBe(one.hash);
});
test('REST keeps an unchanged Threads post as one file when its media URLs were re-signed', async () => {
  const settings = {
    endpoint: 'http://127.0.0.1:27123',
    folder: 'raw/articles/test',
    apiKey: 'synthetic-threads-unit-key',
  };
  const files = new Map<string, string>();
  const client = new ObsidianRestClient(settings, async (input, options) => {
    const path = new URL(String(input)).pathname;
    if (options?.method === 'PUT') {
      files.set(path, String(options.body));
      return new Response(null, { status: 204 });
    }
    return files.has(path) ? new Response(files.get(path)) : new Response(null, { status: 404 });
  });
  const job = async (post: ThreadsPost): Promise<BackupJob> => {
    const note = await renderThreadsNote({ root: post, replies: [], limited: false });
    return {
      ...note,
      key: note.hash,
      target: await apiDestination(settings),
      state: 'pending',
      modules: ['ThreadsSavedModule'],
      due: 0,
      attempts: 0,
      error: '',
      createdAt: 0,
    };
  };
  expect((await client.write(await job(withMedia(firstLoad)))).result).toBe('created');
  for (const urls of [secondLoad, firstLoad, secondLoad])
    expect((await client.write(await job(withMedia(urls)))).result).toBe('existing');
  expect([...files.keys()].filter((path) => path.includes('/revisions/'))).toEqual([]);
  expect((await client.write(await job(withMedia(secondLoad, '수정된 내용')))).result).toBe(
    'revision',
  );
});
test('Packaged content scripts exclude Unicode noncharacters rejected by Chrome', () => {
  const manifest = JSON.parse(readFileSync('dist/chrome/manifest.json', 'utf8'));
  const threads = manifest.content_scripts.find((entry: { js: string[] }) =>
    entry.js.includes('threads-content.js'),
  );
  expect(threads.world).toBe('ISOLATED');
  expect(threads.matches).toContain('https://www.threads.com/*');
  expect(threads.matches).not.toContain('<all_urls>');
  for (const entry of manifest.content_scripts) {
    for (const file of entry.js) {
      const script = readFileSync('dist/chrome/' + file, 'utf8');
      expect(
        [...script].some((character) => {
          const code = character.codePointAt(0)!;
          return (code >= 0xfdd0 && code <= 0xfdef) || (code & 0xffff) >= 0xfffe;
        }),
      ).toBe(false);
    }
  }
  expect(manifest.web_accessible_resources[0].resources).toEqual(['app.js']);
});

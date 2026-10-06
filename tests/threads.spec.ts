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

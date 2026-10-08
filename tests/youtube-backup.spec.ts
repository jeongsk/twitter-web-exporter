import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { renderYoutubeNote } from '../src/youtube/format';
import { queueYoutube } from '../src/youtube/queue';
import { youtubeUrl, type YoutubeVideo } from '../src/youtube/model';
import { knownFromJobs } from '../src/backup/auto-collect';
import { ObsidianRestClient, apiDestination } from '../src/backup/rest';
import type { BackupDatabase, BackupJob } from '../src/backup/queue';
import type { BackupConfig } from '../src/backup/types';

const video = (id = 'dQw4w9WgXcQ', extra: Partial<YoutubeVideo> = {}): YoutubeVideo => ({
  id,
  url: youtubeUrl(id),
  title: '테스트 영상 제목',
  channel: '테스트 채널',
  channelUrl: 'https://www.youtube.com/@test-channel',
  duration: '12:34',
  ...extra,
});
const front = (markdown: string) => {
  const end = markdown.indexOf('\n---\n', 4);
  return {
    lines: markdown.slice(4, end).split('\n'),
    body: markdown.slice(end + 5),
  };
};

test('YouTube note hash ignores the ingest date and covers only stable metadata', async () => {
  const first = await renderYoutubeNote(video(), new Date('2026-10-01T00:00:00Z'));
  const second = await renderYoutubeNote(video(), new Date('2026-10-08T00:00:00Z'));
  expect(first.hash).toBe(second.hash);
  expect(first.markdown).not.toBe(second.markdown);
  expect(first.platform).toBe('youtube');
  expect(first.id).toBe('dQw4w9WgXcQ');
  const { lines, body } = front(first.markdown);
  expect(createHash('sha256').update(body).digest('hex')).toBe(first.hash);
  expect(body).not.toContain('2026');
  expect(body).toContain('## YouTube 좋아요 영상');
  expect(body).toContain('![](<https://www.youtube.com/watch?v=dQw4w9WgXcQ>)');
  expect(body).toContain('[YouTube 원문](<https://www.youtube.com/watch?v=dQw4w9WgXcQ>)');
  expect(body).toContain('채널: [테스트 채널](<https://www.youtube.com/@test-channel>)');
  expect(body).toContain('길이: 12:34');
  expect(body).toContain('![](<https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg>)');
  expect(lines).toEqual([
    'title: "YouTube · 테스트 채널 · 테스트 영상 제목"',
    'source_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"',
    'source_id: "dQw4w9WgXcQ"',
    'source_platform: "youtube"',
    'source_key: "youtube-dQw4w9WgXcQ"',
    'author: ["테스트 채널"]',
    'channel_url: "https://www.youtube.com/@test-channel"',
    'duration: "12:34"',
    'thumbnail: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"',
    'ingested: "2026-10-01"',
    `sha256: "${first.hash}"`,
    'generator: "twitter-web-exporter"',
    'tags: ["youtube","clippings"]',
    'backup_kind: "youtube-liked"',
  ]);
  // A changed title is a new revision.
  expect((await renderYoutubeNote(video(undefined, { title: '바뀐 제목' }))).hash).not.toBe(
    first.hash,
  );
});

test('YouTube note escapes user text and handles missing channel link and duration', async () => {
  const hostile = video('a-b_c-D_e-F', {
    title: '![[secret]] <script>x</script>\n## 가짜 제목 `code` 😀',
    channel: '[채널](https://evil.example)\n---',
    channelUrl: '',
    duration: '',
  });
  const note = await renderYoutubeNote(hostile);
  const { lines, body } = front(note.markdown);
  expect(body).not.toContain('![[secret]]');
  expect(body).not.toContain('<script>');
  expect(body).not.toContain('\n## 가짜');
  expect(body).not.toContain('\n---');
  expect(body).toContain('제목: \\!\\[\\[secret\\]\\] &lt;script&gt;');
  expect(body).toContain('채널: \\[채널\\]\\(https://evil.example\\) ---\n');
  expect(body).not.toContain('길이:');
  expect(lines).toContain('channel_url: null');
  expect(lines).toContain('duration: null');
  expect(lines.filter((l) => l.startsWith('title: '))).toHaveLength(1);
  // Frontmatter values are JSON scalars, so a newline cannot open a new key.
  expect(lines.every((l) => /^[a-z_0-9]+: /.test(l))).toBe(true);
  // Long titles are truncated by code point; no lone surrogate is left behind.
  const long = await renderYoutubeNote(video(undefined, { title: '😀'.repeat(300) }));
  const title = JSON.parse(front(long.markdown).lines[0]!.slice('title: '.length)) as string;
  expect(title.endsWith('…')).toBe(true);
  expect(title.isWellFormed()).toBe(true);
  await expect(renderYoutubeNote({ ...video(), url: 'https://evil.example/' })).rejects.toThrow();
});

/** Minimal in-memory stand-in for the Dexie calls queueYoutube makes. */
function memoryDb() {
  const jobs = new Map<string, BackupJob>();
  const db = {
    jobs: {
      get: async (key: string) => jobs.get(key),
      add: async (job: BackupJob) => {
        if (jobs.has(job.key)) throw new Error('duplicate key');
        jobs.set(job.key, job);
      },
      where: (field: 'state') => ({
        equals: (value: string) => ({
          count: async () => [...jobs.values()].filter((job) => job[field] === value).length,
        }),
      }),
    },
    transaction: async (_mode: string, _table: unknown, task: () => Promise<void>) => task(),
  };
  return { jobs, db: db as unknown as BackupDatabase };
}
const cfg: BackupConfig = {
  enabled: true,
  scope: 'bookmarks',
  destinationId: 'dest',
  youtubeEnabled: true,
};

test('queueYoutube pauses when disabled and rejects malformed batches', async () => {
  const { jobs, db } = memoryDb();
  expect(await queueYoutube(db, [video()], { ...cfg, youtubeEnabled: false })).toEqual({
    ok: true,
    accepted: 0,
    paused: true,
  });
  expect(await queueYoutube(db, [video()], { ...cfg, enabled: false })).toMatchObject({
    paused: true,
  });
  expect(jobs.size).toBe(0);
  await expect(queueYoutube(db, { videos: [video()] }, cfg)).rejects.toThrow();
  await expect(queueYoutube(db, [video(), { ...video(), id: 'short' }], cfg)).rejects.toThrow();
  await expect(queueYoutube(db, [{ ...video(), title: '' }], cfg)).rejects.toThrow();
  const many = Array.from({ length: 101 }, (_, i) => video(`v${String(i).padStart(10, '0')}`));
  await expect(queueYoutube(db, many, cfg)).rejects.toThrow();
  await expect(queueYoutube(db, [video()], { ...cfg, destinationId: '' })).rejects.toThrow();
  expect(jobs.size).toBe(0);
});

test('queueYoutube keys jobs by destination, platform, id and hash and skips duplicates', async () => {
  const { jobs, db } = memoryDb();
  const a = video('AAAAAAAAAAA');
  const b = video('b-_bbbbbbbb');
  expect(await queueYoutube(db, [a, b, a], cfg)).toEqual({ ok: true, accepted: 3 });
  expect(jobs.size).toBe(2);
  const note = await renderYoutubeNote(a);
  const job = jobs.get(`dest:youtube:AAAAAAAAAAA:${note.hash}`)!;
  expect(job).toMatchObject({
    id: 'AAAAAAAAAAA',
    hash: note.hash,
    platform: 'youtube',
    target: 'dest',
    state: 'pending',
    modules: ['YoutubeLikesModule'],
    due: 0,
    attempts: 0,
  });
  expect(job.kind).toBeUndefined();
  // Re-collecting the same list adds nothing; an edited title is a new job.
  await queueYoutube(db, [a, b], cfg);
  expect(jobs.size).toBe(2);
  await queueYoutube(db, [{ ...a, title: '새 제목' }], cfg);
  expect(jobs.size).toBe(3);
  // Another vault is another destination.
  await queueYoutube(db, [a], { ...cfg, destinationId: 'other' });
  expect([...jobs.keys()].filter((key) => key.startsWith('other:youtube:'))).toHaveLength(1);
});

test('queueYoutube respects the shared 5,000 pending job cap', async () => {
  const { jobs, db } = memoryDb();
  for (let i = 0; i < 5000; i++) jobs.set(`x${i}`, { key: `x${i}`, state: 'pending' } as BackupJob);
  await expect(queueYoutube(db, [video()], cfg)).rejects.toThrow('5,000');
});

test('known ids for YouTube come only from liked-video jobs', () => {
  const jobs = [
    { key: 'dest:youtube:AAAAAAAAAAA:hash', modules: ['YoutubeLikesModule'] },
    { key: 'dest:youtube:b-_bbbbbbbb:hash', modules: ['YoutubeLikesModule'] },
    { key: 'dest:youtube:too-short:hash', modules: ['YoutubeLikesModule'] },
    { key: 'dest:youtube:CCCCCCCCCCC:hash', modules: ['ThreadsSavedModule'] },
    { key: 'dest:1001:aaaa', modules: ['BookmarksModule'] },
  ];
  expect(knownFromJobs(jobs, 'youtube')).toEqual(['AAAAAAAAAAA', 'b-_bbbbbbbb']);
  expect(knownFromJobs(jobs, 'x')).toEqual(['1001']);
  expect(knownFromJobs(jobs, 'threads')).toEqual([]);
});

test('REST writes YouTube notes under youtube/ and preserves originals on change', async () => {
  const settings = {
    endpoint: 'http://127.0.0.1:27123',
    folder: 'raw/articles/test',
    apiKey: 'synthetic-youtube-unit-key',
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
  const makeJob = async (item: YoutubeVideo): Promise<BackupJob> => {
    const note = await renderYoutubeNote(item);
    const target = await apiDestination(settings);
    return {
      ...note,
      key: `${target}:youtube:${note.id}:${note.hash}`,
      target,
      state: 'pending',
      modules: ['YoutubeLikesModule'],
      due: 0,
      attempts: 0,
      error: '',
      createdAt: 0,
    };
  };
  const first = await makeJob(video('-_aB3-_cD4e'));
  const written = await client.write(first);
  expect(written).toEqual({
    path: 'raw/articles/test/youtube/youtube--_aB3-_cD4e.md',
    result: 'created',
  });
  expect(files.has('/vault/raw/articles/test/youtube/youtube--_aB3-_cD4e.md')).toBe(true);
  expect((await client.write(first)).result).toBe('existing');
  expect(writes).toBe(1);
  const changed = await client.write(await makeJob(video('-_aB3-_cD4e', { title: '바뀐 제목' })));
  expect(changed.result).toBe('revision');
  expect(changed.path).toContain('/youtube/revisions/youtube--_aB3-_cD4e-');
  expect(files.get('/vault/' + written.path)).toContain('테스트 영상 제목');
  expect(writes).toBe(2);

  // Ids outside the 11-char alphabet and notes whose frontmatter does not match are refused.
  await expect(client.write({ ...first, id: '../../etc/pw' })).rejects.toThrow();
  await expect(client.write({ ...first, platform: undefined })).rejects.toThrow();
  const other = await makeJob(video('ZZZZZZZZZZZ'));
  await expect(client.write({ ...other, id: first.id })).rejects.toThrow();
  expect(writes).toBe(2);
});

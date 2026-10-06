import { BackupConnectionError, withTimeout } from '../src/backup/connection-errors';
import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { isBackupRecord, renderNote, literalMarkdown } from '../src/backup/format';
import {
  normalizeEndpoint,
  normalizeFolder,
  apiDestination,
  ObsidianRestClient,
} from '../src/backup/rest';
import type { BackupRecord } from '../src/backup/types';
import type { BackupJob } from '../src/backup/queue';

export const sample: BackupRecord = {
  id: '9007199254740993',
  text: '한글 본문\n둘째 줄',
  screenName: 'sample_user',
  name: '테스트 사용자',
  published: '2026-09-22T10:00:00.000Z',
  links: ['https://example.com/'],
  media: [],
  related: [],
};
const settings = {
  endpoint: 'http://127.0.0.1:27123',
  folder: 'raw/articles/twitter-web-exporter',
  apiKey: 'synthetic-test-key-000000',
};
async function job(record = sample): Promise<BackupJob> {
  const note = await renderNote(record);
  const target = await apiDestination(settings);
  return {
    ...note,
    target,
    key: `${target}:${note.id}:${note.hash}`,
    state: 'pending',
    modules: ['BookmarksModule'],
    due: 0,
    attempts: 0,
    error: '',
    createdAt: 0,
  };
}
function mockApi() {
  const files = new Map<string, string>();
  const calls: { url: string; method: string }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    calls.push({ url: url.pathname, method });
    expect(init?.redirect).toBe('error');
    expect(init?.credentials).toBe('omit');
    if (url.pathname === '/')
      return Response.json({
        service: 'Obsidian Local REST API',
        authenticated: true,
        versions: { self: '5.2.0' },
      });
    if (method === 'PUT') {
      files.set(url.pathname, String(init?.body));
      return new Response(null, { status: 204 });
    }
    return files.has(url.pathname)
      ? new Response(files.get(url.pathname))
      : new Response(null, { status: 404 });
  };
  return { files, calls, client: new ObsidianRestClient(settings, fetcher) };
}
test('Markdown has real newlines, stable UTF-8 checksum and quoted source ID', async () => {
  const first = await renderNote(sample, new Date('2026-09-22T00:00:00Z'));
  const later = await renderNote(sample, new Date('2026-09-23T00:00:00Z'));
  expect(first.markdown.startsWith('---\n')).toBe(true);
  const body = first.markdown.split('\n---\n').slice(1).join('\n---\n');
  expect(first.hash).toBe(createHash('sha256').update(body).digest('hex'));
  expect(first.hash).toBe(later.hash);
  expect(first.markdown).toContain('source_id: "9007199254740993"');
  expect(first.markdown).toContain('> 한글 본문\n> 둘째 줄');
});
test('backup record boundary and Markdown escaping reject unsafe data', () => {
  expect(isBackupRecord(sample)).toBe(true);
  expect(isBackupRecord({ ...sample, id: '../../evil' })).toBe(false);
  expect(isBackupRecord({ ...sample, text: '\0' })).toBe(false);
  expect(isBackupRecord({ ...sample, links: ['javascript:alert(1)'] })).toBe(false);
  expect(literalMarkdown('<script>![[secret]]```dataviewjs')).not.toContain('<script>');
  expect(literalMarkdown('![[secret]]')).toContain('\\!\\[\\[');
});
test('REST restricts network destinations and vault relative paths', () => {
  expect(normalizeEndpoint('https://127.0.0.1:27124/')).toBe('https://127.0.0.1:27124');
  for (const endpoint of [
    'https://example.org:27124',
    'https://127.0.0.1.attacker.org:27124',
    'https://localhost:27124/redirect',
    'http://user:pw@localhost:27123',
    'file:///wiki',
  ])
    expect(() => normalizeEndpoint(endpoint)).toThrow();
  for (const path of ['../wiki', '/absolute', '.obsidian', 'a//b', 'raw/%2e%2e', ''])
    expect(() => normalizeFolder(path)).toThrow();
});
test('new files are verified and identical data are idempotent', async () => {
  const api = mockApi();
  const value = await job();
  expect((await api.client.connect()).ok).toBe(true);
  expect((await api.client.write(value)).result).toBe('created');
  expect((await api.client.write(value)).result).toBe('existing');
  expect(api.calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
});
test('changed content and human edits preserve the original file', async () => {
  const api = mockApi();
  const first = await job();
  const path = (await api.client.write(first)).path;
  api.files.set('/vault/' + path, 'Human edited note');
  const next = await job({ ...sample, text: '내용 변경' });
  expect((await api.client.write(next)).result).toBe('revision');
  expect(api.files.get('/vault/' + path)).toBe('Human edited note');
});
test('wrong destination and authentication failure do not write anything', async () => {
  const api = mockApi();
  await expect(api.client.write({ ...(await job()), target: 'wrong' })).rejects.toThrow(
    '저장 위치',
  );
  const denied = new ObsidianRestClient(
    settings,
    async () => new Response('do not log this', { status: 401 }),
  );
  await expect(denied.connect()).rejects.toThrow('인증');
  expect(api.calls).toHaveLength(0);
});

test('connection diagnostics distinguish unauthenticated health, HTTPS network failure and invalid JSON', async () => {
  const wrongKey = new ObsidianRestClient(settings, async () =>
    Response.json({
      service: 'Obsidian Local REST API',
      authenticated: false,
    }),
  );
  await expect(wrongKey.connect()).rejects.toMatchObject({ code: 'AUTH' });
  const network = new ObsidianRestClient(
    { ...settings, endpoint: 'https://127.0.0.1:27124' },
    async () => {
      throw new TypeError('Failed to fetch');
    },
  );
  await expect(network.connect()).rejects.toMatchObject({ code: 'TLS_OR_NETWORK' });
  for (const body of ['null', '[]', 'not JSON', '{"service":42}']) {
    const invalid = new ObsidianRestClient(settings, async () => new Response(body));
    await expect(invalid.connect()).rejects.toMatchObject({ code: 'RESPONSE' });
  }
});
test('bounded UI waits report timeout without exposing any request data', async () => {
  await expect(
    withTimeout(new Promise(() => {}), 5, '권한 확인 시간 초과', 'PERMISSION_TIMEOUT'),
  ).rejects.toMatchObject({ code: 'PERMISSION_TIMEOUT' });
  expect(await withTimeout(Promise.resolve(true), 1000, 'unused', 'TIMEOUT')).toBe(true);
  expect(new BackupConnectionError('safe message', 'AUTH').message).toBe('safe message');
});

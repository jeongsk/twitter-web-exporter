import { test, expect, chromium, type Page } from '@playwright/test';
import { build } from 'vite';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { browserPath } from './browser';
import type { ThreadsPost } from '../src/threads/model';

let probe = '';
test.beforeAll(async () => {
  const built = await build({
    configFile: false,
    logLevel: 'error',
    resolve: { alias: { '@': resolve('src') } },
    build: {
      write: false,
      minify: false,
      lib: {
        entry: resolve('src/threads/dom.ts'),
        name: 'ThreadsReadOnlyProbe',
        formats: ['iife'],
      },
    },
  });
  const output = Array.isArray(built) ? built[0] : built;
  if (!output || !('output' in output)) throw new Error('Missing DOM test bundle');
  const chunk = output.output.find((item) => item.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Missing DOM test code');
  probe = chunk.code;
});
async function inspect(html: string, run: (page: Page) => Promise<void>) {
  const executablePath = browserPath();
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', (route) =>
      route.request().isNavigationRequest()
        ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: html })
        : route.abort(),
    );
    await page.goto('https://www.threads.com/saved');
    await page.addScriptTag({ content: probe });
    await run(page);
  } finally {
    await browser.close();
  }
}
type Result = { posts: ThreadsPost[]; candidates: number; skipped: number };
async function extract(page: Page): Promise<Result> {
  return page.evaluate('ThreadsReadOnlyProbe.extractThreadsPage(document, location.href, true)');
}
test('anonymized real saved layout retains four complete cards', async () => {
  const html = await readFile('tests/fixtures/threads-saved-live-anonymized.html', 'utf8');
  await inspect(html, async (page) => {
    const result = await extract(page);
    expect(result.posts.map((post) => post.code)).toEqual([
      'LiveCard1',
      'LiveCard2',
      'LiveCard3',
      'LiveCard4',
    ]);
    expect(result.skipped).toBe(0);
    expect(result.posts.map((post) => post.media.length)).toEqual([1, 4, 2, 1]);
    for (const post of result.posts) {
      expect(post.text).toContain('Anonymous fragment');
      expect(post.text).not.toContain('fixture.user');
      expect(post.text).not.toMatch(/28분|5시간|6시간/);
      expect(post.published).toBe('2026-09-22T12:00:00.000Z');
      expect(post.media.some((media) => media.alt.includes('profile'))).toBe(false);
    }
    expect(result.posts[0]!.text).not.toContain('Anonymous fragment 6');
    expect(result.posts[3]!.text).not.toContain('Anonymous fragment 18');
  });
});
test('wrapped metadata is not a post; inline URLs and quotes do not split a saved card', async () => {
  const header = (code: string) =>
    `<div><a href="/@writer">writer</a><span dir="auto"><a href="/@writer/post/${code}"><time datetime="2026-09-22T12:00:00Z">어제</time></a></span><a href="/topic/tools"><span dir="auto">헤더 주제</span></a></div>`;
  const html = `<!doctype html><body>
    <div>${header('Wrapped')}<div><span dir="auto">짧은 글 <a href="/@another/post/Inline">본문 속 링크</a></span></div><div><img width="100" height="100" src="https://cdn.example/own.jpg" alt="own"></div><blockquote><a href="/@quote/post/Quoted">인용</a><span dir="auto">별도 인용 본문</span></blockquote></div>
    <div>${header('MetadataOnly')}<a href="/@writer"><img width="32" height="32" src="https://cdn.example/avatar.jpg" alt="profile picture"></a></div>
    <div>${header('PhotoOnly')}<div><img width="100" height="100" src="https://cdn.example/photo.jpg" alt="photo"></div></div>
  </body>`;
  await inspect(html, async (page) => {
    const result = await extract(page);
    expect(result.posts.map((post) => post.code)).toEqual(['Wrapped', 'PhotoOnly']);
    expect(result.posts[0]!.text).toBe('짧은 글 본문 속 링크');
    expect(result.posts[0]!.media).toHaveLength(1);
    expect(result.posts[1]!.text).toBe('');
    expect(result.posts[1]!.media[0]!.url).toBe('https://cdn.example/photo.jpg');
    expect(result.skipped).toBe(1);
  });
});

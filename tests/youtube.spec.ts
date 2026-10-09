import { test, expect, chromium, type Page } from '@playwright/test';
import { build } from 'vite';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { browserPath } from './browser';
import {
  isYoutubeLikes,
  isYoutubePage,
  isYoutubeVideo,
  parseYoutubeVideo,
  youtubeUrl,
  type YoutubeVideo,
} from '../src/youtube/model';
import { lastContinuation } from '../src/youtube/continuation';

test.describe('YouTube model', () => {
  test('lastContinuation finds the last load-more command in either layout', () => {
    const lockupCommand = { continuationCommand: { token: 'B' } };
    const actions = [
      {
        appendContinuationItemsAction: {
          continuationItems: [
            { lockupViewModel: {} },
            {
              continuationItemViewModel: {
                continuationCommand: { innertubeCommand: { continuationCommand: { token: 'A' } } },
              },
            },
            {
              continuationItemViewModel: {
                continuationCommand: { innertubeCommand: lockupCommand },
              },
            },
          ],
        },
      },
    ];
    expect(lastContinuation(actions)).toBe(lockupCommand);
    const endpoint = { continuationCommand: { token: 'C' } };
    expect(
      lastContinuation({
        contents: [{ continuationItemRenderer: { continuationEndpoint: endpoint } }],
      }),
    ).toBe(endpoint);
    expect(
      lastContinuation([
        { appendContinuationItemsAction: { continuationItems: [{ lockupViewModel: {} }] } },
      ]),
    ).toBeNull();
    expect(lastContinuation(null)).toBeNull();
  });

  test('parseYoutubeVideo accepts watch, shorts and youtu.be links only', () => {
    expect(parseYoutubeVideo('https://www.youtube.com/watch?v=Abc123_-xyZ&list=LL&index=3')).toBe(
      'Abc123_-xyZ',
    );
    expect(parseYoutubeVideo('/watch?v=Abc123_-xyZ&list=LL')).toBe('Abc123_-xyZ');
    expect(parseYoutubeVideo('https://m.youtube.com/watch?v=Abc123_-xyZ')).toBe('Abc123_-xyZ');
    expect(parseYoutubeVideo('https://www.youtube.com/shorts/Sht0000000S')).toBe('Sht0000000S');
    expect(parseYoutubeVideo('/shorts/Sht0000000S/')).toBe('Sht0000000S');
    expect(parseYoutubeVideo('https://youtu.be/Abc123_-xyZ?t=10')).toBe('Abc123_-xyZ');
    for (const bad of [
      'https://evil.example/watch?v=Abc123_-xyZ',
      'https://www.youtube.com.evil.example/watch?v=Abc123_-xyZ',
      'http://www.youtube.com/watch?v=Abc123_-xyZ',
      'https://www.youtube.com:8443/watch?v=Abc123_-xyZ',
      'https://user@www.youtube.com/watch?v=Abc123_-xyZ',
      'https://www.youtube.com/watch?v=short',
      'https://www.youtube.com/watch?v=Abc123_-xyZ0',
      'https://www.youtube.com/@channel',
      'https://www.youtube.com/playlist?list=LL',
      'javascript:alert(1)',
      'https://youtu.be/',
    ])
      expect(parseYoutubeVideo(bad), bad).toBeNull();
  });
  test('isYoutubeLikes only matches the Liked videos playlist', () => {
    expect(isYoutubeLikes('https://www.youtube.com/playlist?list=LL')).toBe(true);
    expect(isYoutubeLikes('https://youtube.com/playlist?list=LL&pp=x')).toBe(true);
    expect(isYoutubeLikes('https://www.youtube.com/playlist?list=WL')).toBe(false);
    expect(isYoutubeLikes('https://www.youtube.com/playlist?list=PLabc')).toBe(false);
    expect(isYoutubeLikes('https://www.youtube.com/watch?v=Abc123_-xyZ&list=LL')).toBe(false);
    expect(isYoutubeLikes('http://www.youtube.com/playlist?list=LL')).toBe(false);
    expect(isYoutubeLikes('https://evil.example/playlist?list=LL')).toBe(false);
    expect(isYoutubePage('https://music.youtube.com/')).toBe(false);
  });
  test('isYoutubeVideo rejects malformed records', () => {
    const ok: YoutubeVideo = {
      id: 'Abc123_-xyZ',
      url: youtubeUrl('Abc123_-xyZ'),
      title: 'Title',
      channel: 'Channel',
      channelUrl: 'https://www.youtube.com/@channel',
      duration: '12:34',
    };
    expect(isYoutubeVideo(ok)).toBe(true);
    expect(isYoutubeVideo({ ...ok, channelUrl: '', duration: '' })).toBe(true);
    expect(isYoutubeVideo({ ...ok, duration: '1:02:03' })).toBe(true);
    for (const bad of [
      null,
      [],
      'Abc123_-xyZ',
      { ...ok, id: 'short' },
      { ...ok, url: 'https://youtu.be/Abc123_-xyZ' },
      { ...ok, title: '   ' },
      { ...ok, title: 'x'.repeat(1001) },
      { ...ok, title: 'a\u0000b' },
      { ...ok, channel: 1 },
      { ...ok, channelUrl: 'https://evil.example/@channel' },
      { ...ok, channelUrl: 'javascript:alert(1)' },
      { ...ok, duration: 'LIVE' },
      { ...ok, duration: '12:3' },
      { ...ok, duration: '12' },
    ])
      expect(isYoutubeVideo(bad), JSON.stringify(bad)).toBe(false);
  });
});

let probe = '';
test.describe('YouTube Liked videos DOM', () => {
  test.beforeAll(async () => {
    const built = await build({
      configFile: false,
      logLevel: 'error',
      resolve: { alias: { '@': resolve('src') } },
      build: {
        write: false,
        minify: false,
        lib: { entry: resolve('src/youtube/dom.ts'), name: 'YoutubeProbe', formats: ['iife'] },
      },
    });
    const output = Array.isArray(built) ? built[0] : built;
    if (!output || !('output' in output)) throw new Error('Missing DOM test bundle');
    const chunk = output.output.find((item) => item.type === 'chunk');
    if (!chunk || chunk.type !== 'chunk') throw new Error('Missing DOM test code');
    probe = chunk.code;
  });
  async function inspect(html: string, run: (page: Page) => Promise<void>) {
    const browser = await chromium.launch({ executablePath: browserPath(), headless: true });
    try {
      const page = await browser.newPage();
      await page.route('**/*', (route) =>
        route.request().isNavigationRequest()
          ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: html })
          : route.abort(),
      );
      await page.goto('https://www.youtube.com/playlist?list=LL');
      await page.addScriptTag({ content: probe });
      await run(page);
    } finally {
      await browser.close();
    }
  }
  type Result = { videos: YoutubeVideo[]; skipped: number };
  const extract = (page: Page): Promise<Result> =>
    page.evaluate('YoutubeProbe.extractYoutubeLikes(document)');

  test('playlist rows are read in order, deduplicated and normalized', async () => {
    const html = await readFile('tests/fixtures/youtube-likes.html', 'utf8');
    await inspect(html, async (page) => {
      const result = await extract(page);
      expect(result.videos).toEqual([
        {
          id: 'Abc123_-xyZ',
          url: 'https://www.youtube.com/watch?v=Abc123_-xyZ',
          title: 'Sample lecture: part one',
          channel: 'Example Channel',
          channelUrl: 'https://www.youtube.com/@example.channel',
          duration: '12:34',
        },
        {
          id: 'Lng000000A1',
          url: 'https://www.youtube.com/watch?v=Lng000000A1',
          title: 'A very long documentary',
          channel: '다큐 채널',
          channelUrl: 'https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa',
          duration: '1:02:03',
        },
        {
          id: 'Sht0000000S',
          url: 'https://www.youtube.com/watch?v=Sht0000000S',
          title: 'Quick tip #shorts',
          channel: 'Shorts Maker',
          channelUrl: 'https://www.youtube.com/@shorts.maker',
          duration: '',
        },
        {
          id: 'Liv0000000L',
          url: 'https://www.youtube.com/watch?v=Liv0000000L',
          title: 'Live coding stream',
          channel: 'Streamer',
          channelUrl: 'https://www.youtube.com/@streamer',
          duration: '',
        },
      ]);
      // Private, deleted and a row without a rendered channel link.
      expect(result.skipped).toBe(3);
      for (const video of result.videos) expect(isYoutubeVideo(video)).toBe(true);
    });
  });

  test('newer lockup layout is supported', async () => {
    const lockup = (id: string, title: string, badge: string) => `
      <yt-lockup-view-model class="ytd-item-section-renderer lockup"><div class="yt-lockup-view-model yt-lockup-view-model--horizontal">
        <a href="/watch?v=${id}&amp;list=LL&amp;index=1" class="yt-lockup-view-model__content-image">
          <yt-thumbnail-view-model><img src="https://i.ytimg.com/vi/${id}/hqdefault.jpg" alt="">
            <yt-thumbnail-overlay-badge-view-model><yt-thumbnail-badge-view-model><badge-shape class="yt-badge-shape"><div class="yt-badge-shape__text">${badge}</div></badge-shape></yt-thumbnail-badge-view-model></yt-thumbnail-overlay-badge-view-model>
          </yt-thumbnail-view-model>
        </a>
        <div class="yt-lockup-view-model__metadata"><yt-lockup-metadata-view-model><div class="yt-lockup-metadata-view-model__text-container">
          <h3 title="${title}" class="yt-lockup-metadata-view-model__heading-reset"><a href="/watch?v=${id}&amp;list=LL" class="yt-lockup-metadata-view-model__title"><span class="yt-core-attributed-string">${title}</span></a></h3>
          <div class="yt-lockup-metadata-view-model__metadata"><yt-content-metadata-view-model><div class="yt-content-metadata-view-model__metadata-row">
            <span class="yt-core-attributed-string"><a class="yt-core-attributed-string__link" href="/@lockup.channel">Lockup Channel</a></span>
          </div><div class="yt-content-metadata-view-model__metadata-row"><span>조회수 10회</span></div></yt-content-metadata-view-model></div>
        </div></yt-lockup-metadata-view-model></div>
      </div></yt-lockup-view-model>`;
    const html = `<!DOCTYPE html><html><body><ytd-browse page-subtype="playlist"><div id="contents">
      ${lockup('Lck0000000A', 'Lockup one', '4:05')}${lockup('Lck0000000B', 'Lockup two', 'LIVE')}
    </div></ytd-browse></body></html>`;
    await inspect(html, async (page) => {
      const result = await extract(page);
      expect(result.skipped).toBe(0);
      expect(
        result.videos.map((v) => [v.id, v.title, v.channel, v.channelUrl, v.duration]),
      ).toEqual([
        [
          'Lck0000000A',
          'Lockup one',
          'Lockup Channel',
          'https://www.youtube.com/@lockup.channel',
          '4:05',
        ],
        [
          'Lck0000000B',
          'Lockup two',
          'Lockup Channel',
          'https://www.youtube.com/@lockup.channel',
          '',
        ],
      ]);
    });
  });

  test('collaboration videos keep plain-text channel names without a URL', async () => {
    // Structure copied from the live Liked videos page (2026-10): the names are not links.
    const html = `<!DOCTYPE html><html><body><ytd-browse page-subtype="playlist"><div id="contents">
      <yt-lockup-view-model><div>
        <a href="/watch?v=Col0000000A&amp;list=LL&amp;index=87"><badge-shape><div>3:21</div></badge-shape></a>
        <h3 title="Collab title"><a href="/watch?v=Col0000000A&amp;list=LL&amp;index=87">Collab title</a></h3>
        <yt-content-metadata-view-model>
          <div class="ytContentMetadataViewModelMetadataRow"><span class="ytAttributedStringHost ytContentMetadataViewModelMetadataText">First Channel</span><span class="ytIconWrapperHost ytContentMetadataViewModelIcon"><span class="yt-icon-shape"></span></span><span class="ytContentMetadataViewModelDelimiter"> • </span><span class="ytAttributedStringHost ytContentMetadataViewModelMetadataText">및 Second Channel</span></div>
          <div class="ytContentMetadataViewModelMetadataRow"><span class="ytAttributedStringHost ytContentMetadataViewModelMetadataText">7.4천</span><span class="ytContentMetadataViewModelDelimiter"> • </span><span class="ytAttributedStringHost ytContentMetadataViewModelMetadataText">2년 전</span></div>
        </yt-content-metadata-view-model>
      </div></yt-lockup-view-model>
    </div></ytd-browse></body></html>`;
    await inspect(html, async (page) => {
      const result = await extract(page);
      expect(result.skipped).toBe(0);
      expect(
        result.videos.map((v) => [v.id, v.title, v.channel, v.channelUrl, v.duration]),
      ).toEqual([['Col0000000A', 'Collab title', 'First Channel 및 Second Channel', '', '3:21']]);
    });
  });

  test('unknown layouts fall back to Liked-videos links', async () => {
    const card = (id: string, title: string) => `
      <div class="card"><a href="/watch?v=${id}&amp;list=LL&amp;index=2"><img alt=""><span>7:00</span></a>
        <div><a href="/watch?v=${id}&amp;list=LL&amp;index=2">${title}</a><a href="/@fallback">Fallback</a></div></div>`;
    const html = `<!DOCTYPE html><html><body><div id="page">
      <header><a href="/watch?v=Fbk0000000A&amp;list=LL">Play all</a></header>
      <section>${card('Fbk0000000A', 'Fallback one')}${card('Fbk0000000B', 'Fallback two')}
      <div class="card"><a href="/watch?v=Fbk0000000C&amp;list=LL">Orphan without channel</a></div>
      <div class="card"><a href="/watch?v=Oth0000000D&amp;list=WL">Other playlist</a><a href="/@x">X</a></div></section>
    </div></body></html>`;
    await inspect(html, async (page) => {
      const result = await extract(page);
      expect(result.videos.map((v) => [v.id, v.title, v.channelUrl])).toEqual([
        ['Fbk0000000A', 'Fallback one', 'https://www.youtube.com/@fallback'],
        ['Fbk0000000B', 'Fallback two', 'https://www.youtube.com/@fallback'],
      ]);
      expect(result.skipped).toBe(1);
    });
  });
});

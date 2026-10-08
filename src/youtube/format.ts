import { literalMarkdown, fingerprint } from '@/backup/format';
import { isYoutubeVideo, youtubeThumbnail, type YoutubeVideo } from './model';

/** Titles and channel names may contain newlines; one line keeps headings and links intact. */
const line = (value: string) => value.replace(/\s+/g, ' ').trim();
/** Code-point truncation: YouTube titles often contain emoji, never split a surrogate pair. */
function truncate(value: string, max: number) {
  const chars = Array.from(value);
  return chars.length > max
    ? chars
        .slice(0, max - 1)
        .join('')
        .trimEnd() + '…'
    : value;
}

/** Only stable metadata goes into the body, so a re-collected video hashes identically. */
function body(video: YoutubeVideo): string {
  const channel = line(video.channel);
  const name = channel ? literalMarkdown(channel) : '채널 정보 없음';
  return [
    '## YouTube 좋아요 영상',
    '',
    `![](<${video.url}>)`,
    '',
    `[YouTube 원문](<${video.url}>)`,
    '',
    `제목: ${literalMarkdown(line(video.title))}`,
    `채널: ${video.channelUrl ? `[${name}](<${video.channelUrl}>)` : name}`,
    ...(video.duration ? [`길이: ${video.duration}`] : []),
    '',
    `썸네일: ![](<${youtubeThumbnail(video.id)}>)`,
    '',
    '제목·채널·링크 등 메타데이터만 저장합니다. 영상 파일은 포함하지 않습니다.',
  ].join('\n');
}

export async function renderYoutubeNote(video: YoutubeVideo, now = new Date()) {
  if (!isYoutubeVideo(video)) throw new Error('YouTube 영상 형식이 올바르지 않습니다.');
  const content = body(video) + '\n';
  const hash = await fingerprint(content);
  const channel = line(video.channel);
  const properties = {
    title: `YouTube · ${truncate(channel || '알 수 없는 채널', 60)} · ${truncate(line(video.title), 120)}`,
    source_url: video.url,
    source_id: video.id,
    source_platform: 'youtube',
    source_key: `youtube-${video.id}`,
    author: channel ? [channel] : [],
    channel_url: video.channelUrl || null,
    duration: video.duration || null,
    thumbnail: youtubeThumbnail(video.id),
    ingested: now.toISOString().slice(0, 10),
    sha256: hash,
    generator: 'twitter-web-exporter',
    tags: ['youtube', 'clippings'],
    backup_kind: 'youtube-liked',
  };
  // Quoted JSON scalars/arrays are valid YAML, preventing frontmatter injection.
  const markdown =
    '---\n' +
    Object.entries(properties)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join('\n') +
    '\n---\n' +
    content;
  return { id: video.id, hash, markdown, platform: 'youtube' as const };
}

import type { BackupRecord } from './types';

const recordObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, limit: number): value is string =>
  typeof value === 'string' && value.length <= limit && !value.includes('\0');
const id = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{1,30}$/.test(value);
const handle = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:[a-zA-Z0-9_]{1,30})?$/.test(value);
export function safeWebUrl(value: unknown): value is string {
  if (!text(value, 4096) || /[\s<>"`\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}
export function isBackupRecord(value: unknown): value is BackupRecord {
  if (!recordObject(value)) return false;
  return (
    id(value.id) &&
    text(value.text, 100000) &&
    handle(value.screenName) &&
    text(value.name, 500) &&
    text(value.published, 40) &&
    (!value.published ||
      (/^\d{4}-\d\d-\d\dT/.test(value.published) &&
        Number.isFinite(Date.parse(value.published)))) &&
    Array.isArray(value.links) &&
    value.links.length <= 100 &&
    value.links.every(safeWebUrl) &&
    Array.isArray(value.media) &&
    value.media.length <= 16 &&
    value.media.every(
      (m) =>
        recordObject(m) &&
        ['photo', 'video', 'animated_gif'].includes(String(m.type)) &&
        safeWebUrl(m.url) &&
        text(m.alt, 10000),
    ) &&
    Array.isArray(value.related) &&
    value.related.length <= 2 &&
    value.related.every(
      (r) =>
        recordObject(r) &&
        id(r.id) &&
        handle(r.screenName) &&
        text(r.text, 100000) &&
        (r.kind === 'quote' || r.kind === 'repost'),
    )
  );
}

/** Escape untrusted text, including Obsidian embeds and executable fenced plugin blocks. */
export function literalMarkdown(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\`*_{}()#!|~$[\]]/g, '\\$&');
}
const quoted = (value: string) =>
  literalMarkdown(value.replace(/\r\n?/g, '\n'))
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
const link = (url: string) => url.replace(/\(/g, '%28').replace(/\)/g, '%29');
export const tweetUrl = (tweet: { id: string; screenName: string }) =>
  `https://x.com/${tweet.screenName || 'i/web'}/status/${tweet.id}`;

/** Only stable source content affects the fingerprint. Like/view counters do not cause revisions. */
export function noteBody(record: BackupRecord): string {
  const parts = [
    '## 게시물',
    '',
    `[X 원문](${tweetUrl(record)})`,
    '',
    `작성자: ${literalMarkdown(record.name)}${record.screenName ? ` (@${literalMarkdown(record.screenName)})` : ''}`,
    ...(record.published ? [`게시 시각: ${record.published}`] : []),
    '',
    quoted(record.text),
  ];
  for (const related of record.related) {
    parts.push(
      '',
      `## ${related.kind === 'quote' ? '인용한 게시물' : '재게시 원문'}`,
      '',
      `[원문](${tweetUrl(related)})`,
      '',
      quoted(related.text),
    );
  }
  if (record.links.length) {
    parts.push(
      '',
      '## 본문 링크',
      '',
      ...[...new Set(record.links)].map((url, i) => `[링크 ${i + 1}](${link(url)})`),
    );
  }
  if (record.media.length) {
    parts.push('', '## 미디어 링크', '', '미디어 파일 자체는 별도로 다운로드해야 합니다.', '');
    record.media.forEach((m, i) =>
      parts.push(
        `[${m.type === 'photo' ? '사진' : m.type === 'video' ? '동영상' : 'GIF'} ${i + 1}](${link(m.url)})`,
        ...(m.alt ? [quoted(m.alt)] : []),
        '',
      ),
    );
  }
  return parts.join('\n').trimEnd() + '\n';
}
export async function fingerprint(body: string): Promise<string> {
  const bytes = new TextEncoder().encode(body);
  if (bytes.length > 512 * 1024) throw new Error('한 게시물의 백업 크기가 512 KiB를 초과합니다.');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
export async function renderNote(record: BackupRecord, now = new Date()) {
  const body = noteBody(record);
  const hash = await fingerprint(body);
  // Quoted JSON scalars/arrays are valid YAML, preventing frontmatter injection.
  const properties = {
    title: `X · ${record.screenName ? '@' + record.screenName : record.name} · ${record.id}`,
    source_url: tweetUrl(record),
    source_id: record.id,
    author: [record.screenName ? '@' + record.screenName : record.name],
    published: record.published || null,
    ingested: now.toISOString().slice(0, 10),
    sha256: hash,
    generator: 'twitter-web-exporter',
    tags: ['x', 'clippings'],
  };
  const markdown =
    '---\n' +
    Object.entries(properties)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join('\n') +
    '\n---\n' +
    body;
  return { id: record.id, hash, markdown };
}

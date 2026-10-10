import { literalMarkdown, fingerprint } from '@/backup/format';
import { MAX_THREAD_BYTES } from '@/backup/types';
import {
  isThreadsBundle,
  orderedReplies,
  threadsMediaKey,
  threadsStorageId,
  type ThreadsPost,
  type ThreadsBundle,
} from './model';

const quote = (text: string) =>
  literalMarkdown(text.replace(/\r\n?/g, '\n'))
    .split('\n')
    .map((line) => '> ' + line)
    .join('\n');
function body(post: ThreadsPost): string {
  const parts = [
    `[Threads 원문](${post.url})`,
    '',
    `작성자: @${literalMarkdown(post.author)}`,
    ...(post.published
      ? [`게시 시각: ${post.published}`]
      : ['게시 시각: 페이지에서 확인되지 않음']),
    '',
    quote(post.text),
  ];
  if (post.truncated)
    parts.push('', '본문에 더 보기 표시가 있습니다. 원문에서 펼친 뒤 다시 수집하세요.');
  if (post.links.length)
    parts.push('', '본문 링크:', ...post.links.map((u, i) => `[링크 ${i + 1}](<${u}>)`));
  if (post.media.length)
    parts.push(
      '',
      '미디어 URL (파일 자체는 포함하지 않음):',
      ...post.media.flatMap((m, i) => [
        `[${m.type === 'photo' ? '사진' : '동영상'} ${i + 1}](<${m.url}>)`,
        ...(m.alt ? [quote(m.alt)] : []),
      ]),
    );
  return parts.join('\n');
}
const MEDIA_LINE = /^(\[(?:사진|동영상) \d+\]\(<)([^>\n]+)(>\))$/gm;
/**
 * The fingerprint of a note body. Media links are reduced to their stable identity, because Meta
 * re-signs CDN URLs on every load and an unchanged post must not become a revision.
 */
export async function threadsFingerprint(body: string): Promise<string> {
  return fingerprint(
    body.replace(MEDIA_LINE, (_, open, url, close) => open + threadsMediaKey(url) + close),
    MAX_THREAD_BYTES,
  );
}
export async function renderThreadsNote(bundle: ThreadsBundle, now = new Date()) {
  if (!isThreadsBundle(bundle)) throw new Error('Threads 북마크 묶음 형식이 올바르지 않습니다.');
  const replies = orderedReplies(bundle.root, bundle.replies);
  const parts = [
    '## Threads 저장 게시물',
    '',
    body(bundle.root),
    '',
    '## 수집 범위',
    '',
    '브라우저에 로드된 본문과 명시적인 답글 대상 링크로 연결된 댓글만 포함합니다. 전체 본문·댓글 수집 완료를 의미하지 않습니다.',
    `함께 저장한 댓글: ${replies.length}개`,
    ...(bundle.limited ? ['크기 제한으로 일부 자료가 누락되었습니다.'] : []),
  ];
  for (const { post, depth } of replies)
    parts.push(
      '',
      `## 댓글 · @${literalMarkdown(post.author)}`,
      '',
      `답글 깊이: ${depth}`,
      '',
      body(post),
    );
  const content = parts.join('\n').trimEnd() + '\n';
  const hash = await threadsFingerprint(content);
  const id = threadsStorageId(bundle.root.code);
  const properties = {
    title: `Threads · @${bundle.root.author} · ${bundle.root.code}`,
    source_url: bundle.root.url,
    source_id: bundle.root.code,
    source_platform: 'threads',
    source_key: `threads-${id}`,
    author: ['@' + bundle.root.author],
    published: bundle.root.published || null,
    ingested: now.toISOString().slice(0, 10),
    sha256: hash,
    generator: 'twitter-web-exporter',
    tags: ['threads', 'clippings'],
    backup_kind: 'threads-saved',
    replies_captured: replies.length,
    replies_complete: false,
    capture_scope: 'loaded-saved-post-and-explicit-replies',
    text_truncated: bundle.root.truncated,
    limited: bundle.limited,
  };
  const markdown =
    '---\n' +
    Object.entries(properties)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join('\n') +
    '\n---\n' +
    content;
  if (new TextEncoder().encode(markdown).length > MAX_THREAD_BYTES)
    throw new Error('Threads 묶음이 4 MiB를 초과했습니다.');
  return {
    id,
    hash,
    markdown,
    kind: 'thread' as const,
    platform: 'threads' as const,
    replyCount: replies.length,
  };
}

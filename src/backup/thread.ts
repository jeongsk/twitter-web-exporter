import { isBackupRecord, literalMarkdown, noteBody, fingerprint, tweetUrl } from './format';
import {
  MAX_THREAD_BYTES,
  MAX_THREAD_REPLIES,
  type BackupRecord,
  type ThreadBackup,
} from './types';

export type OrderedReply = { record: BackupRecord; depth: number };

/** Parent-before-child ordering, stable across pages and repeated captures. */
export function orderThreadReplies(root: BackupRecord, records: BackupRecord[]): OrderedReply[] {
  const byParent = new Map<string, BackupRecord[]>();
  const seen = new Set([root.id]);
  const unique = new Map(records.map((record) => [record.id, record]));
  for (const record of unique.values()) {
    if (!record.replyTo || record.id === root.id) continue;
    if (
      root.conversationId &&
      record.conversationId &&
      root.conversationId !== record.conversationId
    )
      continue;
    const children = byParent.get(record.replyTo) ?? [];
    children.push(record);
    byParent.set(record.replyTo, children);
  }
  for (const children of byParent.values())
    children.sort((a, b) => {
      const aa = BigInt(a.id),
        bb = BigInt(b.id);
      return aa < bb ? -1 : aa > bb ? 1 : 0;
    });
  const queue = [{ id: root.id, depth: 0 }];
  const result: OrderedReply[] = [];
  for (let i = 0; i < queue.length; i++) {
    const parent = queue[i]!;
    for (const record of byParent.get(parent.id) ?? []) {
      if (seen.has(record.id)) continue;
      seen.add(record.id);
      result.push({ record, depth: parent.depth + 1 });
      queue.push({ id: record.id, depth: parent.depth + 1 });
    }
  }
  return result;
}

export function isThreadBackup(value: unknown): value is ThreadBackup {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const bundle = value as ThreadBackup;
  if (
    !isBackupRecord(bundle.root) ||
    !Array.isArray(bundle.replies) ||
    bundle.replies.length > MAX_THREAD_REPLIES ||
    typeof bundle.limited !== 'boolean' ||
    !bundle.replies.every(isBackupRecord)
  )
    return false;
  if (new Set(bundle.replies.map((r) => r.id)).size !== bundle.replies.length) return false;
  return orderThreadReplies(bundle.root, bundle.replies).length === bundle.replies.length;
}

export async function renderThreadNote(bundle: ThreadBackup, now = new Date()) {
  if (!isThreadBackup(bundle)) throw new Error('북마크와 댓글의 연결 관계가 올바르지 않습니다.');
  const ordered = orderThreadReplies(bundle.root, bundle.replies);
  const original = noteBody(bundle.root).replace(/^## 게시물/, '## 북마크 원문');
  const parts = [
    original.trimEnd(),
    '',
    '## 댓글 수집 상태',
    '',
    `함께 백업한 댓글·대댓글: ${ordered.length}개`,
    '수집 범위: 브라우저에 로드되어 부모 게시물과의 연결을 확인한 댓글만 포함합니다. 전체 댓글 수집 완료를 의미하지 않습니다.',
    ...(bundle.limited
      ? ['묶음 크기 제한에 도달했습니다. 수집된 일부 댓글이 이 파일에 포함되지 않았습니다.']
      : []),
    ...(ordered.length
      ? []
      : [
          '아직 연결된 댓글을 수집하지 않았습니다. 북마크 원문에서 댓글·답글 더 보기를 펼쳐 주세요.',
        ]),
    '',
    '## 댓글과 대댓글',
  ];
  const byId = new Map([bundle.root, ...bundle.replies].map((r) => [r.id, r]));
  ordered.forEach(({ record, depth }, index) => {
    const parent = byId.get(record.replyTo!)!;
    parts.push(
      '',
      `### ${index + 1}. ${depth === 1 ? '댓글' : '대댓글'} · ${literalMarkdown(record.screenName ? '@' + record.screenName : record.name)}`,
      '',
      `답글 깊이: ${depth} · [답글 대상](${tweetUrl(parent)})`,
      '',
      noteBody(record)
        .replace(/^## 게시물\n\n/, '')
        .replace(/^## /gm, '#### ')
        .trimEnd(),
    );
  });
  const body = parts.join('\n').trimEnd() + '\n';
  const hash = await fingerprint(body, MAX_THREAD_BYTES);
  const properties = {
    title: `X 스레드 · ${bundle.root.screenName ? '@' + bundle.root.screenName : bundle.root.name} · ${bundle.root.id}`,
    source_url: tweetUrl(bundle.root),
    source_id: bundle.root.id,
    author: [bundle.root.screenName ? '@' + bundle.root.screenName : bundle.root.name],
    published: bundle.root.published || null,
    ingested: now.toISOString().slice(0, 10),
    sha256: hash,
    generator: 'twitter-web-exporter',
    tags: ['x', 'clippings'],
    backup_kind: 'bookmarked-thread',
    replies_captured: ordered.length,
    replies_complete: false,
    capture_scope: 'loaded-descendants-only',
    limited: bundle.limited,
  };
  const markdown =
    '---\n' +
    Object.entries(properties)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join('\n') +
    '\n---\n' +
    body;
  if (new TextEncoder().encode(markdown).length > MAX_THREAD_BYTES)
    throw new Error('댓글 묶음이 4 MiB를 초과합니다. 백업 대기열에는 추가하지 않았습니다.');
  return {
    id: bundle.root.id,
    hash,
    markdown,
    kind: 'thread' as const,
    replyCount: ordered.length,
  };
}

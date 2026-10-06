import { liveQuery } from 'dexie';
import { useEffect, useState } from 'preact/hooks';
import { useTranslation } from '@/i18n';
import type { ThreadsSource } from './source';
import type { ThreadsPost } from './model';
import type { ThreadsPanelView } from './panel-state';
import { ThreadsDialog } from './panel-dialog';

const PAGE_SIZE = 25;
export function ThreadsTable({
  source,
  view,
  onClose,
}: {
  source: ThreadsSource;
  view: ThreadsPanelView;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { t: e } = useTranslation('exporter');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [data, setData] = useState<{ count: number; posts: ThreadsPost[] }>({
    count: 0,
    posts: [],
  });
  const [error, setError] = useState('');
  useEffect(() => {
    const subscription = liveQuery(() =>
      source.listPanelPosts(view, query, page * PAGE_SIZE, PAGE_SIZE),
    ).subscribe({ next: setData, error: () => setError(t('Failed to read Threads data.')) });
    return () => subscription.unsubscribe();
  }, [source, view, query, page, t]);
  const last = Math.max(0, Math.ceil(data.count / PAGE_SIZE) - 1);
  useEffect(() => {
    if (page > last) setPage(last);
  }, [last, page]);
  const title = view === 'saved' ? t('Threads saved posts') : t('Captured replies');
  return (
    <ThreadsDialog title={title} onClose={onClose}>
      <label class="flex flex-col gap-1 mb-3">
        <span class="text-sm">{t('Search...')}</span>
        <input
          class="input input-bordered input-sm w-full"
          type="search"
          maxLength={200}
          placeholder={t('Search author, content or ID')}
          value={query}
          onInput={(event) => {
            setQuery(event.currentTarget.value);
            setPage(0);
          }}
        />
      </label>
      <p class="text-xs mb-3">{t('Only locally captured Threads data are shown.')}</p>
      <div class="overflow-x-auto twe-threads-table-scroll">
        <table class="table table-sm table-border-bc w-full">
          <thead>
            <tr>
              <th>{e('Screen Name')}</th>
              <th>{e('Content')}</th>
              <th>{e('Date')}</th>
              <th>{e('Media')}</th>
              <th>{e('URL')}</th>
            </tr>
          </thead>
          <tbody>
            {data.posts.map((post) => (
              <tr key={post.code} data-code={post.code}>
                <td class="align-top">
                  @{post.author}
                  <div class="text-xs opacity-60">{post.code}</div>
                </td>
                <td class="align-top twe-threads-text-cell">
                  <details>
                    <summary>{post.text ? post.text.slice(0, 180) : t('Media-only post')}</summary>
                    <p class="whitespace-pre-wrap break-words">{post.text}</p>
                  </details>
                  {post.truncated && (
                    <p class="text-warning text-xs">
                      {t('Open the original to expand truncated text.')}
                    </p>
                  )}
                  {post.replyTo && (
                    <p class="text-xs">
                      {e('Replying To')}: {post.replyTo}
                    </p>
                  )}
                </td>
                <td class="align-top whitespace-nowrap">
                  {post.published ? new Date(post.published).toLocaleString() : '—'}
                </td>
                <td class="align-top">{post.media.length}</td>
                <td class="align-top">
                  <a class="link" href={post.url} target="_blank" rel="noopener noreferrer">
                    {t('Open original')}
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!data.count && <p class="text-sm p-4">{t('No data available.')}</p>}
      </div>
      <div class="flex flex-wrap items-center gap-2 justify-between mt-3">
        <span class="text-xs" role="status">
          {t('A - B of N items', {
            from: data.count ? page * PAGE_SIZE + 1 : 0,
            to: Math.min((page + 1) * PAGE_SIZE, data.count),
            total: data.count,
          })}
        </span>
        <div class="flex gap-1">
          <button
            type="button"
            class="btn btn-xs"
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
          >
            {t('Previous page')}
          </button>
          <button
            type="button"
            class="btn btn-xs"
            disabled={page >= last}
            onClick={() => setPage(page + 1)}
          >
            {t('Next page')}
          </button>
        </div>
      </div>
      {error && (
        <p class="text-error whitespace-pre-wrap mt-2" role="alert">
          {error}
        </p>
      )}
    </ThreadsDialog>
  );
}

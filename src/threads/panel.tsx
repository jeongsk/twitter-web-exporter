import { useEffect, useState } from 'preact/hooks';
import { useSignal } from '@preact/signals';
import { IconBrandThreads, IconSettings, IconX, IconRefresh } from '@tabler/icons-preact';
import { CatIcon, ExtensionPanel } from '@/components/common';
import { ErrorBoundary } from '@/components/error-boundary';
import { RuntimeLogsPanel } from '@/modules/runtime-logs/ui';
import { options, THEMES } from '@/core/options';
import { useTranslation, LANGUAGES_CONFIG } from '@/i18n';
import { THREADS_SAVED } from './model';
import { ThreadsTable } from './panel-table';
import { ThreadsDialog } from './panel-dialog';
import type { ThreadsPanelProps, ThreadsPanelView } from './panel-state';

/** Same components and theme as X, without mounting unsupported X collection modules. */
export function ThreadsPanel(props: ThreadsPanelProps) {
  const { state, visible, settingsOpen, source, onToggle, onScan, onBackup, onError } = props;
  const { t, i18n } = useTranslation();
  const theme = useSignal(options.get('theme'));
  const [view, setView] = useState<ThreadsPanelView | null>(null);
  useEffect(
    () =>
      options.signal.subscribe(() => {
        theme.value = options.get('theme');
      }),
    [],
  );
  const s = state.value;
  const label = t('Open Control Panel');
  return (
    <div class="twe-threads-ui" data-theme={theme.value}>
      <button
        type="button"
        class="twe-threads-launcher group fill-base-content"
        aria-label={label}
        title={label}
        aria-expanded={visible.value}
        aria-controls="twe-threads-panel"
        onClick={onToggle}
      >
        <CatIcon />
      </button>
      <section
        id="twe-threads-panel"
        aria-label="Web Exporter"
        hidden={!visible.value}
        class="twe-threads-control card card-compact bg-base-100 border shadow-xl text-base-content px-4 py-3 rounded-box border-solid border-neutral-content border-opacity-50"
      >
        <header class="flex items-center h-9 shrink-0">
          <IconBrandThreads class="mr-2 shrink-0" aria-hidden="true" />
          <h2 class="font-semibold leading-none text-xl m-0 flex-grow">Web Exporter</h2>
          <button
            type="button"
            class="btn btn-sm btn-circle btn-ghost"
            aria-label={t('Settings')}
            title={t('Settings')}
            onClick={() => {
              settingsOpen.value = true;
            }}
          >
            <IconSettings />
          </button>
          <button
            type="button"
            class="btn btn-sm btn-circle btn-ghost"
            aria-label={t('Close Control Panel')}
            title={t('Close Control Panel')}
            onClick={onToggle}
          >
            <IconX />
          </button>
        </header>
        <p class="text-sm text-base-content text-opacity-70 leading-5 mb-1 mt-1">
          {t('Browse around to capture more data.')}
        </p>
        <div class="divider my-0" />
        <div class="twe-threads-panel-content">
          <div data-module="threads-saved">
            <ExtensionPanel
              title={t('Bookmarks')}
              description={`${t('Captured:')} ${s.savedCount}`}
              active={s.busy}
              indicatorColor="bg-primary"
              actionLabel={t('Threads saved posts')}
              onClick={() => setView('saved')}
            />
          </div>
          <div data-module="threads-replies">
            <ExtensionPanel
              title={t('Captured replies')}
              description={`${t('Captured:')} ${s.replyCount}`}
              active={s.busy}
              indicatorColor="bg-primary"
              actionLabel={t('Captured replies')}
              onClick={() => setView('replies')}
            />
          </div>
          <div data-module="threads-backup">
            <ExtensionPanel
              title={t('Obsidian Automatic Backup')}
              description={t('Backup requests this tab', { count: s.queued })}
              indicatorColor="bg-warning"
              actionLabel={t('Obsidian Automatic Backup')}
              onClick={onBackup}
            />
          </div>
          <p class="text-xs leading-5 my-2 opacity-70" role="status" data-testid="threads-notice">
            {s.notice}
          </p>
          {s.error && (
            <p
              class="text-error text-sm whitespace-pre-wrap break-words my-2"
              role="alert"
              data-testid="threads-error"
            >
              {s.error}
            </p>
          )}
          <div class="flex flex-wrap gap-2 my-2">
            <button type="button" class="btn btn-sm btn-primary" disabled={s.busy} onClick={onScan}>
              <IconRefresh size={16} />
              {s.busy ? t('Collecting...') : t('Collect again')}
            </button>
            <a class="btn btn-sm btn-ghost" href={THREADS_SAVED}>
              {t('Open saved posts')}
            </a>
          </div>
          <p class="text-xs opacity-60 leading-4 mb-2">
            {t('Backup requests are not completed vault writes.')}
          </p>
          <RuntimeLogsPanel />
        </div>
      </section>
      <ErrorBoundary>
        {view && (
          <ThreadsTable key={view} source={source} view={view} onClose={() => setView(null)} />
        )}
        {settingsOpen.value && (
          <ThreadsDialog
            title={t('Settings')}
            onClose={() => {
              settingsOpen.value = false;
            }}
          >
            <p class="text-sm mb-4">Threads · Web Exporter</p>
            <label class="flex items-center justify-between gap-3 mb-3">
              <span>{t('Theme')}</span>
              <select
                class="select select-sm select-bordered"
                aria-label={t('Theme')}
                value={theme.value}
                onChange={(event) => {
                  try {
                    options.set('theme', event.currentTarget.value);
                  } catch (error) {
                    onError(error);
                  }
                }}
              >
                {THEMES.map((value) => (
                  <option key={value} value={value}>
                    {value === 'system' ? t('System') : value}
                  </option>
                ))}
              </select>
            </label>
            <label class="flex items-center justify-between gap-3 mb-4">
              <span>{t('Language')}</span>
              <select
                class="select select-sm select-bordered"
                aria-label={t('Language')}
                value={i18n.resolvedLanguage ?? i18n.language}
                onChange={(event) => {
                  const language = event.currentTarget.value;
                  void i18n.changeLanguage(language);
                  try {
                    options.set('language', language);
                  } catch (error) {
                    onError(error);
                  }
                }}
              >
                {Object.entries(LANGUAGES_CONFIG).map(([value, lang]) => (
                  <option key={value} value={value}>
                    {lang.nameEn} - {lang.name}
                  </option>
                ))}
              </select>
            </label>
            <p class="text-sm mb-2">
              {t('Configure secure local API backup in an extension-only window.')}
            </p>
            <button type="button" class="btn btn-primary btn-sm" onClick={onBackup}>
              {t('Obsidian Automatic Backup')}
            </button>
            {s.error && (
              <p class="text-error text-sm whitespace-pre-wrap mt-3" role="alert">
                {s.error}
              </p>
            )}
            <p class="text-xs opacity-70 mt-3">
              {t('Threads panel preferences are separate from X.')}
            </p>
          </ThreadsDialog>
        )}
      </ErrorBoundary>
    </div>
  );
}

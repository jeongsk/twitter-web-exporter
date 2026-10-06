import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { IconX } from '@tabler/icons-preact';
import { useTranslation } from '@/i18n';

/** Native modal manages focus, Escape and the inert page backdrop. */
export function ThreadsDialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ComponentChildren;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const { t } = useTranslation();
  useLayoutEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      class="modal twe-threads-dialog"
      aria-label={title}
      onClose={onClose}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          ref.current?.close();
        }
      }}
    >
      <div class="modal-box p-4 max-w-4xl">
        <header class="flex items-center gap-2 mb-4">
          <h2 class="m-0 text-xl font-semibold flex-grow">{title}</h2>
          <button
            type="button"
            class="btn btn-sm btn-circle btn-ghost"
            aria-label={t('Close')}
            onClick={() => ref.current?.close()}
          >
            <IconX />
          </button>
        </header>
        {children}
      </div>
      <form method="dialog" class="modal-backdrop">
        <button type="submit" aria-label={t('Close')}>
          {t('Close')}
        </button>
      </form>
    </dialog>
  );
}

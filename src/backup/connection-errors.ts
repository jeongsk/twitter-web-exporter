/** Safe, actionable diagnostics shared by the worker and the settings page. */
export class BackupConnectionError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'BackupConnectionError';
  }
}

/** Do not leave controls disabled forever if a permission or worker response never arrives. */
export async function withTimeout<T>(
  task: Promise<T>,
  milliseconds: number,
  message: string,
  code: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new BackupConnectionError(message, code)), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

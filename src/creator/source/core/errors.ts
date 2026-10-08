export class AppError extends Error {
  constructor(public code: string, message: string, public currentRevision?: number) { super(message); }
}
export function safeError(error: unknown) {
  if (error instanceof AppError) return { code: error.code, message: error.message, currentRevision: error.currentRevision };
  return { code: 'OPERATION_FAILED', message: 'The operation could not finish. Inspect the current project before retrying, or check the local diagnostics.' };
}

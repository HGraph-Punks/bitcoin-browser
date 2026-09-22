export class AppError extends Error {
  constructor(code, message, options = {}) {
    super(message, { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = options.status ?? 500;
    this.retryable = Boolean(options.retryable);
    this.details = options.details ?? null;
  }
}

export function toAppError(error, fallbackCode = 'INTERNAL_ERROR') {
  if (error instanceof AppError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new AppError(fallbackCode, message, { cause: error });
}

export function serializeError(error) {
  const normalized = toAppError(error);
  return {
    name: normalized.name,
    code: normalized.code,
    message: normalized.message,
    status: normalized.status,
    retryable: normalized.retryable,
    details: normalized.details
  };
}

export function errorFromSerialized(value) {
  if (!value || typeof value !== 'object') {
    return new AppError('INTERNAL_ERROR', 'Unknown application error');
  }
  return new AppError(value.code ?? 'INTERNAL_ERROR', value.message ?? 'Unknown application error', {
    status: value.status,
    retryable: value.retryable,
    details: value.details
  });
}

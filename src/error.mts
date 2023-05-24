export const INNER_ERROR = Symbol("Inner error");

export class ActionError extends Error {
  [INNER_ERROR]: unknown;

  constructor(message?: string, inner?: unknown) {
    super(message);
    this[INNER_ERROR] = inner;
  }
}

export function isHttpError(err: unknown): err is { status: number } & Error {
  if (!(err instanceof Error)) return false;
  if (err.name !== "HttpError") return false;

  const indexable = err as { [key: string]: unknown } & Error;
  if (!Object.prototype.hasOwnProperty.call(indexable, "status")) return false;
  if (typeof indexable.status !== "number") return false;

  return true;
}

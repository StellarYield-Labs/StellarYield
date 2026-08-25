export class RequestCancelledError extends Error {
  constructor(message: string = "Request was cancelled before completion.") {
    super(message);
    this.name = "RequestCancelledError";
  }
}

export function isRequestCancelledError(error: unknown): error is RequestCancelledError {
  return error instanceof RequestCancelledError;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new RequestCancelledError();
  }
}

export function toRequestCancelledError(error: unknown): RequestCancelledError | null {
  if (error instanceof RequestCancelledError) {
    return error;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return new RequestCancelledError();
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new RequestCancelledError();
  }
  return null;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

export async function fetchJson<T>(
  url: string,
  init: RequestInit & RequestOptions = {},
): Promise<T> {
  const { signal, ...fetchInit } = init;
  throwIfAborted(signal);

  try {
    const response = await fetch(url, { ...fetchInit, signal });
    throwIfAborted(signal);

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(text || `Request failed (${response.status})`);
    }

    return (await response.json()) as T;
  } catch (error) {
    const cancelled = toRequestCancelledError(error);
    if (cancelled) {
      throw cancelled;
    }
    throw error;
  }
}

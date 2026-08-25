import { RequestCancelledError } from "../errors";
import type { RequestOptions } from "../types";

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

export async function apiRequest<T>(
  url: string,
  init: RequestInit & RequestOptions = {},
): Promise<T> {
  const { signal, ...fetchInit } = init;
  throwIfAborted(signal);

  try {
    const response = await fetch(url, { ...fetchInit, signal });
    throwIfAborted(signal);

    if (!response.ok) {
      const detail = response.statusText || String(response.status);
      throw new Error(`Request failed (${response.status}): ${detail}`);
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

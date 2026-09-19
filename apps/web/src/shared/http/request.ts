export class HttpError extends Error {
  constructor(message: string, public readonly code: string, public readonly status: number, public readonly retryable: boolean) {
    super(message);
    this.name = "HttpError";
  }
}

/** A transport failure after a write is an unknown outcome, never evidence that
 * the server rolled back. Agent callers reconcile the same operation identity. */
export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  const timeout = AbortSignal.timeout(options.method && options.method !== "GET" ? 30_000 : 10_000);
  let response: Response;
  try {
    response = await fetch(path, { ...options, headers, cache: "no-store", signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new HttpError(timeout.aborted ? "任务服务响应超时，请重试" : "无法连接任务服务，请检查后端是否已启动后重试", "RESULT_UNKNOWN", 0, true);
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const value = body && typeof body === "object" ? body as Record<string, unknown> : {};
    throw new HttpError(typeof value.message === "string" ? value.message : `任务服务暂时不可用（${response.status}），请重试`, typeof value.code === "string" ? value.code : "HTTP_ERROR", response.status, value.retryable === true);
  }
  if (body === undefined) throw new HttpError("任务服务返回了无效响应，请重试", "RESULT_UNKNOWN", response.status, true);
  return body as T;
}

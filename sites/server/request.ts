import { HttpError } from './errors';

export const MAX_REQUEST_BYTES = 12 * 1024 * 1024;

/** Count the stream before JSON/multipart parsing, including chunked requests. */
export async function boundedRequest(request: Request): Promise<Request> {
  const declared = request.headers.get('Content-Length');
  if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared))))
    throw new HttpError(400, '请求长度格式不正确');
  if (declared !== null && Number(declared) > MAX_REQUEST_BYTES)
    throw new HttpError(413, '请求不得超过 12 MB');
  if (!request.body) return request;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_REQUEST_BYTES) {
        await reader.cancel().catch(() => {});
        throw new HttpError(413, '请求不得超过 12 MB');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Request(request, { body: bytes });
}

/** A tab owns its selected workspace; the global preference is only a default. */
export function requestedWorkspace(request: Request): string | null {
  const header = request.headers.get('X-Workspace-ID');
  const query = new URL(request.url).searchParams.getAll('workspace_id');
  if (query.length > 1 || (header !== null && query.length && header !== query[0]))
    throw new HttpError(400, '企业标识不一致，请刷新后重试');
  const value = header ?? query[0] ?? null;
  if (value !== null && !/^[a-zA-Z0-9_-]{1,150}$/.test(value))
    throw new HttpError(400, '企业标识格式不正确');
  return value;
}

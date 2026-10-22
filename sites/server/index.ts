import { api } from './api';
import { HttpError, type Env } from './storage';
import { RuleError } from './domain';
import { boundedRequest } from './request';
import assets from './assets.json';
function asset(path: string) {
  const entry = (assets as Record<string, { content: string; type: string }>)[path];
  if (!entry) return new Response('Not found', { status: 404 });
  const bytes = Uint8Array.from(atob(entry.content), (c) => c.charCodeAt(0));
  return new Response(bytes, {
    headers: {
      'Content-Type': entry.type,
      'Cache-Control': path.startsWith('/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    },
  });
}
export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    let response: Response;
    try {
      if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(request.method)) {
        if (request.headers.get('X-Requested-With') !== '9810')
          throw new HttpError(403, '无效的请求来源，请从应用内重试');
        const origin = request.headers.get('Origin');
        if (origin && origin !== url.origin) throw new HttpError(403, '无效的请求来源');
        request = await boundedRequest(request);
      }
      if (url.pathname.startsWith('/api/'))
        response = await api(request, env, () => {
          const r = asset('/template.xlsx');
          r.headers.set('Content-Disposition', 'attachment; filename="9810-template.xlsx"');
          return r;
        });
      else if (request.method === 'GET')
        response = asset(url.pathname.startsWith('/assets/') ? url.pathname : '/index.html');
      else response = new Response('Not found', { status: 404 });
    } catch (e) {
      const error = e as Error;
      const status = e instanceof HttpError ? e.status : e instanceof RuleError ? 422 : 500;
      if (status === 500) console.error('9810 request failed', error.message);
      response = Response.json(
        { detail: status === 500 ? '服务暂时不可用，请稍后重试' : error.message },
        { status },
      );
    }
    const headers = new Headers(response.headers);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'same-origin');
    headers.set(
      'Cache-Control',
      url.pathname.startsWith('/api/') ? 'no-store' : headers.get('Cache-Control') || 'no-cache',
    );
    headers.set(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'",
    );
    return new Response(response.body, { status: response.status, headers });
  },
};

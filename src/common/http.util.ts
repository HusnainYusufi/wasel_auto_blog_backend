import { request as httpsRequest } from 'https';
import { request as httpRequest } from 'http';
import { URL } from 'url';

export interface HttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

/**
 * Minimal HTTP client built on Node's core http/https modules.
 *
 * Deliberately not `fetch`: undici picks its own connection strategy and stalls
 * on networks where the host publishes AAAA records but IPv6 is unroutable —
 * exactly the shape of MiniMax's DNS. The core client honours the process-wide
 * `ipv4first` resolution order set in main.ts.
 */
export function httpRequestRaw(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
    timeoutMs?: number;
    maxRedirects?: number;
  } = {},
): Promise<HttpResponse> {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 300_000,
    maxRedirects = 5,
  } = options;

  return new Promise<HttpResponse>((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error(`Invalid URL: ${url}`));
      return;
    }

    const transport = parsed.protocol === 'http:' ? httpRequest : httpsRequest;
    const payload = body
      ? Buffer.isBuffer(body)
        ? body
        : Buffer.from(body, 'utf8')
      : undefined;

    const req = transport(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers: {
          ...headers,
          ...(payload ? { 'Content-Length': String(payload.byteLength) } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;

        if (status >= 300 && status < 400 && location && maxRedirects > 0) {
          res.resume(); // drain so the socket can be reused
          resolve(
            httpRequestRaw(new URL(location, url).toString(), {
              ...options,
              maxRedirects: maxRedirects - 1,
            }),
          );
          return;
        }

        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status, headers: res.headers, body: Buffer.concat(chunks) }),
        );
        res.on('error', reject);
      },
    );

    req.on('timeout', () => {
      req.destroy(new Error(`Request to ${parsed.hostname} timed out`));
    });
    req.on('error', (err: NodeJS.ErrnoException) =>
      reject(new Error(err.code ? `${err.code}: ${err.message}` : err.message)),
    );

    if (payload) req.write(payload);
    req.end();
  });
}

/** POST a JSON body and return the raw response text. */
export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs?: number,
): Promise<{ status: number; text: string }> {
  const res = await httpRequestRaw(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    timeoutMs,
  });

  return { status: res.status, text: res.body.toString('utf8') };
}

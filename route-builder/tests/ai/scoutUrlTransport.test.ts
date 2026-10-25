import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readUrlContentTool, requestPinnedUrl } from '../../server/services/scoutTools/urlSafety.js';
import type { SafeUrlValidationResult } from '../../server/services/scoutTools/types.js';

type ResponseCallback = (incoming: http.IncomingMessage) => void;

type IncomingFixture = http.IncomingMessage & {
  write(chunk: string | Uint8Array): boolean;
  end(chunk?: string | Uint8Array): void;
};

interface CapturedRequest {
  options: https.RequestOptions;
  incoming: IncomingFixture;
  req: http.ClientRequest;
}

type Responder = (
  options: https.RequestOptions,
  callback: ResponseCallback,
  incoming: IncomingFixture
) => void;

/**
 * Installs a narrowly scoped node:https transport mock. Every mocked request resolves
 * its response fixture through a queueMicrotask, mirroring Node's asynchronous response
 * callback without touching a real socket or DNS resolver.
 */
function mockHttpsTransport(respond: Responder) {
  const requests: CapturedRequest[] = [];
  const spy = vi.spyOn(https, 'request').mockImplementation(((
    options: https.RequestOptions,
    callback?: (incoming: http.IncomingMessage) => void
  ) => {
    const req = new PassThrough() as unknown as http.ClientRequest;
    const incoming = new PassThrough() as unknown as IncomingFixture;
    requests.push({ options, incoming, req });
    req.end = (() => {
      queueMicrotask(() => {
        respond(options, callback ?? (() => {}), incoming);
      });
      return req;
    }) as unknown as http.ClientRequest['end'];
    return req;
  }) as unknown as typeof https.request);
  return { spy, requests };
}

function makeValidated(url: string, address = '93.184.216.34'): SafeUrlValidationResult {
  return { url: new URL(url), addresses: [{ address, family: 4 }] };
}

function configureIncoming(
  incoming: IncomingFixture,
  statusCode: number,
  statusMessage: string,
  headers: Record<string, string | string[]>
): void {
  incoming.statusCode = statusCode;
  incoming.statusMessage = statusMessage;
  incoming.headers = headers;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('requestPinnedUrl null-body and construction failures', () => {
  for (const status of [204, 205, 304]) {
    it(`resolves HTTP ${status} with a null body and tears down owned resources`, async () => {
      const { spy, requests } = mockHttpsTransport((_options, callback, incoming) => {
        configureIncoming(
          incoming,
          status,
          status === 304 ? 'Not Modified' : 'No Content',
          { 'content-type': 'text/plain' }
        );
        callback(incoming);
      });

      try {
        const res = await requestPinnedUrl(makeValidated('https://example.com/null-body'), {}, new AbortController().signal);

        expect(res.status).toBe(status);
        expect(res.body).toBeNull();
        await expect(res.text()).resolves.toBe('');
        expect(requests).toHaveLength(1);
        expect(requests[0].options.agent).toBe(false);
        expect(requests[0].options.headers).toMatchObject({ Host: 'example.com' });
        expect(requests[0].incoming.destroyed).toBe(true);
        expect(requests[0].req.destroyed).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });
  }

  it('handles an HTTP 204 end-to-end through readUrlContentTool instead of crashing', async () => {
    const { spy, requests } = mockHttpsTransport((_options, callback, incoming) => {
      configureIncoming(incoming, 204, 'No Content', { 'content-type': 'text/plain' });
      callback(incoming);
    });
    const dnsLookup = vi.fn(async (): Promise<Array<{ address: string; family: number }>> => [
      { address: '93.184.216.34', family: 4 },
    ]);

    try {
      const result = await readUrlContentTool(
        { url: 'https://example.com/no-content' },
        { dnsLookup, urlTimeoutMs: 2_000 }
      );

      expect(result.url).toBe('https://example.com/no-content');
      expect(result.content).toBe('');
      expect(result.truncated).toBe(false);
      expect(requests[0].incoming.destroyed).toBe(true);
      expect(requests[0].req.destroyed).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects invalid status, header, and statusText metadata instead of throwing from the HTTP callback', async () => {
    interface InvalidCase {
      name: string;
      statusCode?: number;
      statusMessage: string;
      headers: Record<string, string | string[]>;
      error: RegExp;
    }

    const cases: InvalidCase[] = [
      {
        name: 'status below the Response range',
        statusCode: 99,
        statusMessage: '',
        headers: {},
        error: /Invalid HTTP response status from upstream: 99/,
      },
      {
        name: 'status above the Response range',
        statusCode: 600,
        statusMessage: '',
        headers: {},
        error: /Invalid HTTP response status from upstream: 600/,
      },
      {
        name: 'missing status',
        statusMessage: '',
        headers: {},
        error: /Invalid HTTP response status from upstream: undefined/,
      },
      {
        name: 'invalid header name',
        statusCode: 200,
        statusMessage: 'OK',
        headers: { 'bad header': 'value' },
        error: /Failed to construct response headers/,
      },
      {
        name: 'invalid statusText',
        statusCode: 200,
        statusMessage: 'OK\r\nInjected: yes',
        headers: { 'content-type': 'text/plain' },
        error: /Failed to construct HTTP 200 response: Invalid statusText/,
      },
    ];

    for (const testCase of cases) {
      const { spy, requests } = mockHttpsTransport((_options, callback, incoming) => {
        if (testCase.statusCode !== undefined) {
          incoming.statusCode = testCase.statusCode;
        }
        incoming.statusMessage = testCase.statusMessage;
        incoming.headers = testCase.headers;
        callback(incoming);
      });

      try {
        await expect(
          requestPinnedUrl(makeValidated('https://example.com/invalid-metadata'), {}, new AbortController().signal)
        ).rejects.toThrow(testCase.error);
        expect(requests[0].incoming.destroyed).toBe(true);
        expect(requests[0].req.destroyed).toBe(true);
      } finally {
        spy.mockRestore();
      }
    }
  });
});

describe('requestPinnedUrl successful bodies', () => {
  it('preserves pinned lookup, Host, SNI, agent:false, and a small response body', async () => {
    let lookupAll: Array<{ address: string; family: number }> | undefined;
    let lookupSingle: { address: string; family: number } | undefined;

    const { spy, requests } = mockHttpsTransport((options, callback, incoming) => {
      if (typeof options.lookup === 'function') {
        options.lookup('example.com', { all: true }, (_err, addresses) => {
          if (Array.isArray(addresses)) {
            lookupAll = addresses;
          }
        });
        options.lookup('example.com', { all: false }, (_err, address, family) => {
          if (typeof address === 'string' && typeof family === 'number') {
            lookupSingle = { address, family };
          }
        });
      }
      configureIncoming(incoming, 200, 'OK', { 'content-type': 'text/plain' });
      callback(incoming);
      incoming.end('hello pinned world');
    });

    try {
      const res = await requestPinnedUrl(
        makeValidated('https://example.com/page'),
        { 'User-Agent': 'transport-test' },
        new AbortController().signal
      );

      await expect(res.text()).resolves.toBe('hello pinned world');
      expect(requests[0].options.agent).toBe(false);
      expect(requests[0].options.hostname).toBe('example.com');
      expect(requests[0].options.headers).toMatchObject({
        Host: 'example.com',
        'User-Agent': 'transport-test',
        'Accept-Encoding': 'identity',
      });
      expect((requests[0].options as { servername?: string }).servername).toBe('example.com');
      expect(lookupAll).toEqual([{ address: '93.184.216.34', family: 4 }]);
      expect(lookupSingle).toEqual({ address: '93.184.216.34', family: 4 });
      expect(requests[0].incoming.destroyed).toBe(true);
      expect(requests[0].req.destroyed).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  for (const encoding of [
    { name: 'gzip', header: 'gzip', compress: (body: Buffer) => zlib.gzipSync(body) },
    { name: 'deflate', header: 'deflate', compress: (body: Buffer) => zlib.deflateSync(body) },
    { name: 'br', header: 'br', compress: (body: Buffer) => zlib.brotliCompressSync(body) },
  ]) {
    it(`decodes a successful ${encoding.name} response body`, async () => {
      const payload = `compressed ${encoding.name} payload`;
      const compressed = encoding.compress(Buffer.from(payload));
      const { spy, requests } = mockHttpsTransport((_options, callback, incoming) => {
        configureIncoming(incoming, 200, 'OK', {
          'content-type': 'text/plain',
          'content-encoding': encoding.header,
        });
        callback(incoming);
        incoming.end(compressed);
      });

      try {
        const res = await requestPinnedUrl(
          makeValidated('https://example.com/compressed'),
          {},
          new AbortController().signal
        );

        await expect(res.text()).resolves.toBe(payload);
        expect(res.headers.get('content-encoding')).toBeNull();
        expect(requests[0].incoming.destroyed).toBe(true);
        expect(requests[0].req.destroyed).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });
  }

  it('follows a manual redirect through the pinned transport', async () => {
    let requestCount = 0;
    const { spy, requests } = mockHttpsTransport((_options, callback, incoming) => {
      requestCount++;
      if (requestCount === 1) {
        configureIncoming(incoming, 302, 'Found', {
          location: 'https://second.example.com/final',
        });
        callback(incoming);
        incoming.end();
        return;
      }
      configureIncoming(incoming, 200, 'OK', { 'content-type': 'text/html; charset=utf-8' });
      callback(incoming);
      incoming.end(
        '<html><head><title>Redirected Guide</title></head><body><p>Final redirected page.</p></body></html>'
      );
    });
    const dnsLookup = vi.fn(
      async (host: string): Promise<Array<{ address: string; family: number }>> => {
        if (host === 'first.example.com') return [{ address: '93.184.216.34', family: 4 }];
        return [{ address: '93.184.216.35', family: 4 }];
      }
    );

    try {
      const result = await readUrlContentTool(
        { url: 'https://first.example.com/start' },
        { dnsLookup, urlTimeoutMs: 2_000 }
      );

      expect(result.url).toBe('https://second.example.com/final');
      expect(result.title).toBe('Redirected Guide');
      expect(result.content).toContain('Final redirected page.');
      expect(dnsLookup).toHaveBeenCalledTimes(2);
      expect(requests).toHaveLength(2);
      expect(requests[0].incoming.destroyed).toBe(true);
      expect(requests[1].incoming.destroyed).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('requestPinnedUrl stream failures and abort teardown', () => {
  it('rejects a bad compressed body and destroys the incoming and request resources', async () => {
    const { spy, requests } = mockHttpsTransport((_options, callback, incoming) => {
      configureIncoming(incoming, 200, 'OK', {
        'content-type': 'text/plain',
        'content-encoding': 'gzip',
      });
      callback(incoming);
      incoming.end(Buffer.from('this is definitely not a gzip stream'));
    });

    try {
      const res = await requestPinnedUrl(
        makeValidated('https://example.com/bad-gzip'),
        {},
        new AbortController().signal
      );

      await expect(res.text()).rejects.toThrow();
      expect(requests[0].incoming.destroyed).toBe(true);
      expect(requests[0].req.destroyed).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects a source stream error on an uncompressed body and destroys owned resources', async () => {
    const { spy, requests } = mockHttpsTransport((_options, callback, incoming) => {
      configureIncoming(incoming, 200, 'OK', { 'content-type': 'text/plain' });
      callback(incoming);
      incoming.write('partial body');
      incoming.destroy(new Error('source stream failed'));
    });

    try {
      const res = await requestPinnedUrl(
        makeValidated('https://example.com/source-error'),
        {},
        new AbortController().signal
      );

      await expect(res.text()).rejects.toThrow('source stream failed');
      expect(requests[0].incoming.destroyed).toBe(true);
      expect(requests[0].req.destroyed).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects a source stream error while a decompressor is owned', async () => {
    const { spy, requests } = mockHttpsTransport((_options, callback, incoming) => {
      configureIncoming(incoming, 200, 'OK', {
        'content-type': 'text/plain',
        'content-encoding': 'gzip',
      });
      callback(incoming);
      incoming.write(zlib.gzipSync(Buffer.from('partial compressed body')));
      incoming.destroy(new Error('compressed source stream failed'));
    });

    try {
      const res = await requestPinnedUrl(
        makeValidated('https://example.com/compressed-source-error'),
        {},
        new AbortController().signal
      );

      await expect(res.text()).rejects.toThrow();
      expect(requests[0].incoming.destroyed).toBe(true);
      expect(requests[0].req.destroyed).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects when aborted before response headers arrive', async () => {
    const { spy, requests } = mockHttpsTransport((_options, callback, incoming) => {
      configureIncoming(incoming, 200, 'OK', { 'content-type': 'text/plain' });
      callback(incoming);
      incoming.end('late body');
    });
    const controller = new AbortController();

    try {
      const pending = requestPinnedUrl(
        makeValidated('https://example.com/abort-before-headers'),
        {},
        controller.signal
      );
      controller.abort();

      await expect(pending).rejects.toThrow('Request aborted');
      await Promise.resolve();
      expect(requests[0].incoming.destroyed).toBe(true);
      expect(requests[0].req.destroyed).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects a body read and tears down resources when aborted after response headers', async () => {
    const { spy, requests } = mockHttpsTransport((_options, callback, incoming) => {
      configureIncoming(incoming, 200, 'OK', { 'content-type': 'text/plain' });
      callback(incoming);
      // Intentionally never end the body: the caller aborts mid-stream.
    });
    const controller = new AbortController();

    try {
      const res = await requestPinnedUrl(
        makeValidated('https://example.com/abort-after-headers'),
        {},
        controller.signal
      );
      expect(res.body).not.toBeNull();

      controller.abort();

      await expect(res.text()).rejects.toThrow('Request aborted');
      expect(requests[0].incoming.destroyed).toBe(true);
      expect(requests[0].req.destroyed).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

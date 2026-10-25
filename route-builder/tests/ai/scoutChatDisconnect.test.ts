import { describe, it, expect, vi } from 'vitest';
import http from 'node:http';
import type { Socket } from 'node:net';
import { once } from 'node:events';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../server/app.js';
import {
  AiService,
  InvalidModelError,
  type AiHarnessAdapter,
} from '../../server/services/aiService.js';
import { ScoutService } from '../../server/services/scoutService.js';
import type { ScoutChatResponse, ScoutTripContext } from '../../server/types/scout.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Flushes pending microtasks and the next check phase without sleeping. */
async function flushEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

const tripContext: ScoutTripContext = {
  tripName: 'Disconnect Regression Trip',
  waypoints: [],
};

const chatPayload = {
  scope: { type: 'day', dayNumber: 1 },
  messages: [{ role: 'user', content: 'Audit this leg' }],
  tripContext,
};

const successResponse: ScoutChatResponse = {
  reply: 'The leg is well paced.',
  suggestions: [],
  sessionId: 'test-session',
  engine: 'bedrock',
  modelId: 'test-scout-model',
};

function createTestAdapter(): AiHarnessAdapter {
  return {
    id: 'bedrock',
    name: 'Test Provider',
    isAvailable: async () => true,
    generate: async () => 'unused',
    validateModelId: async (modelId: string) => modelId,
    getAvailableModels: async () => [],
    getModelCatalog: () => ({
      models: [],
      defaultScoutModelId: 'test-scout-model',
      defaultCopywriterModelId: 'test-copywriter-model',
    }),
    decorateScoutPrompt: (prompt: string) => prompt,
    sanitizeResponse: (text: string) => text,
  };
}

interface ScoutFixture {
  app: FastifyInstance;
  port: number;
  sends: number[];
  scout: ScoutService;
  sockets: Socket[];
}

async function createFixture(): Promise<ScoutFixture> {
  const scout = new ScoutService(new AiService({ adapters: [createTestAdapter()] }));
  const app = createApp({ logger: false, scoutService: scout });
  const sends: number[] = [];
  const sockets: Socket[] = [];

  app.addHook('onSend', async (_request, reply, payload) => {
    sends.push(reply.statusCode);
    return payload;
  });
  app.server.on('connection', (socket: Socket) => {
    sockets.push(socket);
  });

  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { app, port, sends, scout, sockets };
}

async function teardownFixture(fixture: ScoutFixture): Promise<void> {
  for (const socket of fixture.sockets) {
    if (!socket.destroyed) socket.destroy();
  }
  await fixture.app.close();
}

function startChatRequest(port: number): http.ClientRequest {
  const request = http.request({
    host: '127.0.0.1',
    port,
    path: '/api/ai/scout/chat',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  // A deliberate client abort is expected to surface as a socket error.
  request.on('error', () => undefined);
  request.end(JSON.stringify(chatPayload));
  return request;
}

interface ServerSocketSnapshot {
  socket: Socket;
  baselineCloseListeners: number;
}

function nextServerSocket(app: FastifyInstance): Promise<ServerSocketSnapshot> {
  return new Promise<ServerSocketSnapshot>((resolve) => {
    app.server.once('connection', (socket: Socket) => {
      resolve({ socket, baselineCloseListeners: socket.listenerCount('close') });
    });
  });
}

async function destroyServerSocket(socket: Socket): Promise<void> {
  if (socket.destroyed) return;
  const closed = once(socket, 'close');
  socket.destroy();
  await closed;
}

describe('POST /api/ai/scout/chat connection lifecycle', () => {
  it('does not dispatch generation when the client disconnects during deferred model resolution', async () => {
    const fixture = await createFixture();
    const enteredResolve = createDeferred<void>();
    const resolveModel = createDeferred<string>();
    const chatSpy = vi.spyOn(fixture.scout, 'chat');

    vi.spyOn(fixture.scout, 'resolveModelId').mockImplementation(async () => {
      enteredResolve.resolve();
      return resolveModel.promise;
    });

    const socketPromise = nextServerSocket(fixture.app);

    try {
      const request = startChatRequest(fixture.port);
      await enteredResolve.promise;

      const { socket } = await socketPromise;
      const socketClosed = once(socket, 'close');
      request.destroy();
      await socketClosed;

      resolveModel.resolve('test-scout-model');
      await flushEventLoop();

      expect(chatSpy).not.toHaveBeenCalled();
      expect(fixture.sends).toEqual([]);
    } finally {
      await teardownFixture(fixture);
    }
  });

  it('does not send an error when model validation rejects after the client disconnects', async () => {
    const fixture = await createFixture();
    const enteredResolve = createDeferred<void>();
    const resolveModel = createDeferred<string>();
    const chatSpy = vi.spyOn(fixture.scout, 'chat');

    vi.spyOn(fixture.scout, 'resolveModelId').mockImplementation(async () => {
      enteredResolve.resolve();
      return resolveModel.promise;
    });

    const socketPromise = nextServerSocket(fixture.app);

    try {
      const request = startChatRequest(fixture.port);
      await enteredResolve.promise;

      const { socket } = await socketPromise;
      const socketClosed = once(socket, 'close');
      request.destroy();
      await socketClosed;

      resolveModel.reject(new InvalidModelError('Model "missing-model" is not available'));
      await flushEventLoop();

      expect(chatSpy).not.toHaveBeenCalled();
      expect(fixture.sends).toEqual([]);
      expect(fixture.app.server.listening).toBe(true);
    } finally {
      await teardownFixture(fixture);
    }
  });

  it('returns HTTP 200 on a connected request and detaches close listeners afterwards', async () => {
    const fixture = await createFixture();
    let capturedSignal: AbortSignal | undefined;

    vi.spyOn(fixture.scout, 'resolveModelId').mockResolvedValue('test-scout-model');
    const chatSpy = vi.spyOn(fixture.scout, 'chat').mockImplementation(async (_request, options) => {
      capturedSignal = options?.abortSignal;
      return successResponse;
    });

    const socketPromise = nextServerSocket(fixture.app);

    try {
      const response = await fetch(`http://127.0.0.1:${fixture.port}/api/ai/scout/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(chatPayload),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        reply: successResponse.reply,
        engine: 'bedrock',
        modelId: 'test-scout-model',
      });
      expect(chatSpy).toHaveBeenCalledTimes(1);
      expect(capturedSignal?.aborted).toBe(false);
      expect(fixture.sends).toEqual([200]);

      await destroyServerSocket((await socketPromise).socket);
      expect(capturedSignal?.aborted).toBe(false);
    } finally {
      await teardownFixture(fixture);
    }
  });

  it('returns HTTP 400 for an invalid model on a connected request and detaches close listeners', async () => {
    const fixture = await createFixture();
    const chatSpy = vi.spyOn(fixture.scout, 'chat');
    vi.spyOn(fixture.scout, 'resolveModelId').mockRejectedValue(
      new InvalidModelError('Model "not-offered" is not available from this provider')
    );

    const socketPromise = nextServerSocket(fixture.app);

    try {
      const response = await fetch(`http://127.0.0.1:${fixture.port}/api/ai/scout/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(chatPayload),
      });

      expect(response.status).toBe(400);
      const body: { error?: string } = await response.json();
      expect(body.error).toContain('not available');
      expect(chatSpy).not.toHaveBeenCalled();
      expect(fixture.sends).toEqual([400]);

      const { socket, baselineCloseListeners } = await socketPromise;
      expect(socket.listenerCount('close')).toBe(baselineCloseListeners);
      await destroyServerSocket(socket);
    } finally {
      await teardownFixture(fixture);
    }
  });

  it('aborts the generation signal and sends nothing when the client disconnects during chat', async () => {
    const fixture = await createFixture();
    const enteredChat = createDeferred<void>();
    const chatResult = createDeferred<ScoutChatResponse>();
    let capturedSignal: AbortSignal | undefined;

    vi.spyOn(fixture.scout, 'resolveModelId').mockResolvedValue('test-scout-model');
    vi.spyOn(fixture.scout, 'chat').mockImplementation(async (_request, options) => {
      capturedSignal = options?.abortSignal;
      enteredChat.resolve();
      return chatResult.promise;
    });

    const socketPromise = nextServerSocket(fixture.app);

    try {
      startChatRequest(fixture.port);
      await enteredChat.promise;
      expect(capturedSignal?.aborted).toBe(false);

      const socket = (await socketPromise).socket;
      const socketClosed = once(socket, 'close');
      socket.destroy();
      await socketClosed;

      expect(capturedSignal?.aborted).toBe(true);

      chatResult.resolve(successResponse);
      await flushEventLoop();

      expect(fixture.sends).toEqual([]);
    } finally {
      await teardownFixture(fixture);
    }
  });
});

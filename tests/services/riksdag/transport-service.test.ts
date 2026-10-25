/** @fileoverview Real Response boundary tests for transport, budgets and validated caching. @module tests/services/riksdag/transport-service */
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RiksdagService } from '@/services/riksdag/riksdag-service.js';
import {
  createToolBudget,
  type JsonLoadSpec,
  RiksdagTransport,
} from '@/services/riksdag/transport.js';

const schema = z.object({ id: z.string() });
const spec: JsonLoadSpec<typeof schema> = { path: '/dokumentlista/', schema, ttlMs: 120000 };
afterEach(() => vi.useRealTimers());

describe('fixed-origin transport', () => {
  it('classifies a malformed redirect location as deterministic upstream schema failure', async () => {
    vi.useFakeTimers();
    const network = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async () => new Response('', { status: 302, headers: { location: 'http://[' } }),
      );
    const transport = new RiksdagTransport(network);
    using budget = createToolBudget();
    const pending = transport.load(transport.url(spec.path), spec, budget);
    const assertion = expect(pending).rejects.toMatchObject({
      data: { reason: 'upstream_schema_invalid', retryable: false },
    });
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
    expect(network).toHaveBeenCalledTimes(1);
    transport.dispose();
  });
  it('builds sorted explicit queries and rejects caller URLs and query injection', () => {
    const transport = new RiksdagTransport(vi.fn<typeof fetch>());
    expect(
      transport.url('/dokumentlista/', { z: undefined, sz: 10, sok: 'å & b', p: 1 }).href,
    ).toBe('https://data.riksdagen.se/dokumentlista/?p=1&sok=%C3%A5+%26+b&sz=10');
    for (const path of [
      'https://example.test/',
      '//example.test/dokumentlista/',
      '/dokumentlista/?q=x',
      '/dokumentlista/#x',
      '/dokumentlista/\\evil',
    ])
      expect(() => transport.url(path)).toThrow();
    transport.dispose();
  });
  it.each([400, 401, 403, 404, 422])(
    'does not retry deterministic HTTP %i failures',
    async (status) => {
      const network = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => new Response('private body', { status }));
      const transport = new RiksdagTransport(network);
      using budget = createToolBudget();
      await expect(transport.load(transport.url(spec.path), spec, budget)).rejects.toThrow();
      expect(network).toHaveBeenCalledTimes(1);
      transport.dispose();
    },
  );
  it.each([408, 429, 500, 502, 503, 504])(
    'retries transient HTTP %i once within the same budget',
    async (status) => {
      vi.useFakeTimers();
      const network = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('', { status }))
        .mockImplementation(async () => Response.json({ id: 'ok' }));
      const transport = new RiksdagTransport(network);
      using budget = createToolBudget();
      const pending = transport.load(transport.url(spec.path), spec, budget);
      await vi.advanceTimersByTimeAsync(500);
      await expect(pending).resolves.toMatchObject({ found: true, data: { id: 'ok' } });
      expect(network).toHaveBeenCalledTimes(2);
      transport.dispose();
    },
  );
  it('retries body network failures, not fully read malformed JSON or schema mismatches', async () => {
    vi.useFakeTimers();
    const network = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new TypeError('connection reset'));
              },
            }),
          ),
      )
      .mockImplementation(async () => Response.json({ id: 'recovered' }));
    const transport = new RiksdagTransport(network);
    using budget = createToolBudget();
    const pending = transport.load(transport.url(spec.path), spec, budget);
    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toMatchObject({ data: { id: 'recovered' } });
    expect(network).toHaveBeenCalledTimes(2);
    transport.dispose();
    for (const body of ['{bad', '{"id":1}', '<html>Unexpected page</html>']) {
      const badNetwork = vi.fn<typeof fetch>().mockImplementation(async () => new Response(body));
      const badTransport = new RiksdagTransport(badNetwork);
      await expect(
        badTransport.load(badTransport.url(spec.path), spec, budget),
      ).rejects.toMatchObject({ data: { reason: 'upstream_schema_invalid', retryable: false } });
      expect(badNetwork).toHaveBeenCalledTimes(1);
      badTransport.dispose();
    }
  });
  it('distinguishes expected HTTP/HTML misses from service-error HTML', async () => {
    vi.useFakeTimers();
    for (const response of [
      new Response('', { status: 404 }),
      new Response('<html>Sidan kunde inte hittas 404</html>'),
    ]) {
      const network = vi.fn<typeof fetch>().mockResolvedValue(response);
      const transport = new RiksdagTransport(network);
      using budget = createToolBudget();
      await expect(
        transport.load(transport.url(spec.path), { ...spec, expected404: true }, budget),
      ).resolves.toMatchObject({ found: false });
      expect(network).toHaveBeenCalledTimes(1);
      transport.dispose();
    }
    const network = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response('<html>503 Service unavailable</html>'));
    const transport = new RiksdagTransport(network);
    using budget = createToolBudget();
    const pending = transport.load(
      transport.url(spec.path),
      { ...spec, expected404: true },
      budget,
    );
    const assertion = expect(pending).rejects.toMatchObject({
      data: { reason: 'upstream_unavailable', retryable: true },
    });
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
    expect(network).toHaveBeenCalledTimes(2);
    transport.dispose();
  });
  it('follows same-origin redirects manually and rejects external, credential-bearing and excessive redirects', async () => {
    const network = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('', { status: 302, headers: { location: '/dokumentstatus/HC01KU1.json' } }),
      )
      .mockImplementation(async () => Response.json({ id: 'ok' }));
    const transport = new RiksdagTransport(network);
    using budget = createToolBudget();
    await expect(transport.load(transport.url(spec.path), spec, budget)).resolves.toMatchObject({
      data: { id: 'ok' },
    });
    expect(String(network.mock.calls[1]?.[0])).toBe(
      'https://data.riksdagen.se/dokumentstatus/HC01KU1.json',
    );
    expect(network.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      redirect: 'manual',
      headers: { accept: 'application/json' },
    });
    transport.dispose();
    for (const location of [
      'https://example.test/x',
      'http://data.riksdagen.se/x',
      'https://user:pass@data.riksdagen.se/x',
      '/dokumentlista/',
    ]) {
      const redirect = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => new Response('', { status: 302, headers: { location } }));
      const badTransport = new RiksdagTransport(redirect);
      await expect(
        badTransport.load(badTransport.url(spec.path), spec, budget),
      ).rejects.toMatchObject({ data: { reason: 'upstream_schema_invalid' } });
      expect(redirect).toHaveBeenCalledTimes(location === '/dokumentlista/' ? 6 : 1);
      badTransport.dispose();
    }
  });
  it('cancels an active response body without retrying or consuming another permit', async () => {
    const caller = new AbortController();
    const cancelled = vi.fn();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const network = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{'));
              started();
            },
            cancel: cancelled,
          }),
        ),
    );
    const transport = new RiksdagTransport(network);
    using budget = createToolBudget(caller.signal);
    const pending = transport.load(transport.url(spec.path), spec, budget);
    const assertion = expect(pending).rejects.toMatchObject({
      code: JsonRpcErrorCode.RequestCancelled,
    });
    await ready;
    caller.abort();
    await assertion;
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(network).toHaveBeenCalledTimes(1);
    transport.dispose();
  });
  it('uses one 55-second deadline across attempt timeout and retry', async () => {
    vi.useFakeTimers();
    const network = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(new ReadableStream()));
    const transport = new RiksdagTransport(network);
    using budget = createToolBudget();
    const pending = transport.load(transport.url(spec.path), spec, budget);
    const assertion = expect(pending).rejects.toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'tool_deadline_exceeded' },
    });
    await vi.advanceTimersByTimeAsync(55000);
    await assertion;
    expect(network).toHaveBeenCalledTimes(2);
    expect(budget.remainingMs()).toBe(0);
    transport.dispose();
  });
  it('holds two permits through body reads, sheds request 23 and removes cancelled queued callers', async () => {
    const bodies: ReadableStreamDefaultController<Uint8Array>[] = [];
    const started = Array.from({ length: 21 }, () => Promise.withResolvers<void>());
    const network = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              bodies.push(controller);
              started[bodies.length - 1]?.resolve();
            },
          }),
        ),
    );
    const transport = new RiksdagTransport(network);
    const caller = new AbortController();
    using budget = createToolBudget();
    using queuedBudget = createToolBudget(caller.signal);
    const first = transport.load(transport.url(spec.path), spec, budget);
    const second = transport.load(transport.url(spec.path), spec, budget);
    const queued = transport.load(transport.url(spec.path), spec, queuedBudget);
    const cancelledAssertion = expect(queued).rejects.toMatchObject({
      code: JsonRpcErrorCode.RequestCancelled,
    });
    const rest = Array.from({ length: 19 }, () =>
      transport.load(transport.url(spec.path), spec, budget),
    );
    const shed = transport.load(transport.url(spec.path), spec, budget);
    await expect(shed).rejects.toMatchObject({
      data: { reason: 'upstream_queue_full', recovery: { hint: expect.stringContaining('Wait') } },
    });
    expect(network).toHaveBeenCalledTimes(2);
    caller.abort();
    await cancelledAssertion;
    for (let i = 0; i < 21; i++) {
      const controller = bodies[i];
      if (!controller) throw new Error(`Expected active response ${i}.`);
      controller.enqueue(new TextEncoder().encode('{"id":"ok"}'));
      controller.close();
      if (i < 19) await started[i + 2]?.promise;
    }
    await Promise.all([first, second, ...rest]);
    expect(network).toHaveBeenCalledTimes(21);
    transport.dispose();
  });
});

describe('validated service cache', () => {
  it('reparses cached wire data once per read, preserves timestamps and isolates caller mutation', async () => {
    vi.useFakeTimers();
    const network = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ id: '2' }));
    const service = new RiksdagService({ fetch: network });
    const transformed = z.object({ id: z.string().transform(Number) });
    const request = { ...spec, schema: transformed, cacheable: () => true };
    using budget = createToolBudget();
    const first = await service.loadJson(request, budget);
    expect(first).toMatchObject({ data: { id: 2 } });
    if (!first.found) throw new Error('Expected a record.');
    first.data.id = 99;
    vi.advanceTimersByTime(1000);
    await expect(service.loadJson(request, budget)).resolves.toEqual({
      found: true,
      data: { id: 2 },
      retrievedAt: first.retrievedAt,
    });
    expect(network).toHaveBeenCalledTimes(1);
    service.dispose();
  });
  it('expires cached records according to endpoint TTL', async () => {
    vi.useFakeTimers();
    const network = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ id: 'ok' }));
    const service = new RiksdagService({ fetch: network });
    const request = { ...spec, cacheable: () => true };
    {
      using budget = createToolBudget();
      await service.loadJson(request, budget);
    }
    vi.advanceTimersByTime(119999);
    {
      using budget = createToolBudget();
      await service.loadJson(request, budget);
    }
    expect(network).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    {
      using budget = createToolBudget();
      await service.loadJson(request, budget);
    }
    expect(network).toHaveBeenCalledTimes(2);
    service.dispose();
  });
  it('does not cache expected misses, schema failures or a predicate-rejected incomplete result', async () => {
    const network = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockImplementationOnce(async () => Response.json({ id: 1 }))
      .mockImplementation(async () => Response.json({ id: 'incomplete' }));
    const service = new RiksdagService({ fetch: network });
    using budget = createToolBudget();
    const request = {
      ...spec,
      expected404: true,
      cacheable: (data: { id: string }) => data.id === 'complete',
    };
    await expect(service.loadJson(request, budget)).resolves.toMatchObject({ found: false });
    await expect(service.loadJson(request, budget)).rejects.toMatchObject({
      data: { reason: 'upstream_schema_invalid' },
    });
    await service.loadJson(request, budget);
    await service.loadJson(request, budget);
    expect(network).toHaveBeenCalledTimes(4);
    service.dispose();
  });
});

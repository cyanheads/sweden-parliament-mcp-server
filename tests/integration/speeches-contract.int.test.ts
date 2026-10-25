/** @fileoverview Injected-network speech contracts on both consumption paths. @module tests/integration/speeches-contract */
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { riksdagSearchSpeeches } from '@/mcp-server/tools/definitions/search-speeches.tool.js';
import { successEnrichment } from '@/services/riksdag/output.js';
import { getRiksdagService, initRiksdagService } from '@/services/riksdag/riksdag-service.js';
import { speechList, speechRow } from '../services/riksdag/speech-fixtures.js';

afterEach(() => {
  vi.useRealTimers();
  getRiksdagService().dispose();
});

function success(result: Awaited<ReturnType<typeof runToolContract>>) {
  expect(result.isError).not.toBe(true);
  const enrichment = z.object(successEnrichment).parse(result.structuredContent);
  expect(enrichment.source).toBe('Source: The Swedish Parliament');
  const first = result.content[0];
  if (first?.type !== 'text') throw new Error('Expected rendered domain text.');
  const newline = first.text.indexOf('\n');
  const fence = first.text.slice(0, newline).replace(/json$/, '');
  const domain: unknown = JSON.parse(
    first.text.slice(newline + 1, first.text.indexOf(`\n${fence}`, newline)),
  );
  const parsed = riksdagSearchSpeeches.output.parse(result.structuredContent);
  expect(domain).toEqual(parsed);
  const text = result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  for (const value of [
    enrichment.effectiveQuery,
    enrichment.source,
    enrichment.retrievedAt,
    ...enrichment.notices,
  ])
    expect(text).toContain(JSON.stringify(value).slice(1, -1));
  return parsed;
}

describe('speech public contract', () => {
  it('retains CRLF text bytes on both surfaces and renders source links as usable Markdown', async () => {
    initRiksdagService({
      fetch: async () =>
        Response.json({
          anforande: { ...speechRow(), anforandetext: '<pre>first\r\n😀 second\r\nthird</pre>' },
        }),
    });
    const result = await runToolContract(riksdagSearchSpeeches, {
      mode: 'get',
      speechId: 'HC091-1',
      textLength: 100,
    });
    expect(success(result).item?.text).toBe('first\r\n😀 second\r\nthird');
    const first = result.content[0];
    if (first?.type !== 'text') throw new Error('Expected domain text.');
    expect(first.text).toContain('](<https://data.riksdagen.se/anforande/HC091-1>)');
    expect(first.text).toContain('](<https://data.riksdagen.se/anforande/HC091-1/html>)');
  });
  it('propagates caller cancellation during detail body consumption as whole-call failure', async () => {
    const caller = new AbortController();
    const ready = Promise.withResolvers<void>();
    const cancelled = vi.fn();
    initRiksdagService({
      fetch: async (url) =>
        String(url).includes('anforandelista')
          ? Response.json(speechList(1))
          : new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode('{'));
                  ready.resolve();
                },
                cancel: cancelled,
              }),
            ),
    });
    const pending = runToolContract(
      riksdagSearchSpeeches,
      { session: '2024/25' },
      { context: { signal: caller.signal } },
    );
    await ready.promise;
    caller.abort();
    expect(await pending).toMatchObject({
      isError: true,
      structuredContent: { error: { code: JsonRpcErrorCode.RequestCancelled } },
    });
    expect(cancelled).toHaveBeenCalledTimes(1);
  });
  it('shares the 55000ms deadline across list and sequential hydration', async () => {
    vi.useFakeTimers();
    const started = Date.now();
    const detailStarted = Promise.withResolvers<void>();
    const network = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (String(url).includes('anforandelista')) {
        vi.setSystemTime(started + 54000);
        return Response.json(speechList(2));
      }
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{'));
            detailStarted.resolve();
          },
        }),
      );
    });
    initRiksdagService({ fetch: network });
    const pending = runToolContract(riksdagSearchSpeeches, { session: '2024/25', textCount: 2 });
    await detailStarted.promise;
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: JsonRpcErrorCode.Timeout, data: { reason: 'tool_deadline_exceeded' } },
      },
    });
    expect(network).toHaveBeenCalledTimes(2);
  });
  it('searches all heading/subheading tokens without body search and traverses locally using one request', async () => {
    const fixture = speechList(3);
    fixture.anforandelista.anforande[1]!.underrubrik = 'Annan';
    fixture.anforandelista.anforande[2]!.anforandetext = '<p>bodyonly</p>';
    const network = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(fixture));
    initRiksdagService({ fetch: network });
    const first = success(
      await runToolContract(riksdagSearchSpeeches, {
        session: '2024/25',
        headingContains: 'atgarder OSTERSJON',
        memberId: '0001',
        party: 's',
        speechType: 'speech',
        textCount: 0,
        limit: 1,
      }),
    );
    expect(first).toMatchObject({
      candidateCount: 3,
      totalCount: 2,
      items: [{ speechId: 'HC091-1', textState: 'not_requested' }],
      nextCall: {
        args: {
          session: '2024/25',
          memberId: '0001',
          party: 'S',
          speechType: 'speech',
          headingContains: 'atgarder OSTERSJON',
          textCount: 0,
          offset: 1,
          limit: 1,
          revision: first.revision,
        },
      },
    });
    const next = success(await runToolContract(riksdagSearchSpeeches, first.nextCall!.args));
    expect(next).toMatchObject({
      items: [{ speechId: 'HC091-3' }],
      hasMore: false,
      revision: first.revision,
    });
    const body = success(
      await runToolContract(riksdagSearchSpeeches, {
        session: '2024/25',
        headingContains: 'bodyonly',
        textCount: 0,
      }),
    );
    expect(body).toMatchObject({ items: [], totalCount: 0 });
    success(
      await runToolContract(riksdagSearchSpeeches, {
        session: '2024/25',
        offset: 99,
        textCount: 0,
      }),
    );
    expect(network).toHaveBeenCalledTimes(2);
    expect(new URL(String(network.mock.calls[0]?.[0])).searchParams.has('p')).toBe(false);
    expect(new URL(String(network.mock.calls[0]?.[0])).searchParams.has('sok')).toBe(false);
  });
  it('keeps candidate revisions independent of hydration/limit and rejects changed candidates after TTL', async () => {
    vi.useFakeTimers();
    const fixture = speechList(2);
    const network = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url) =>
        String(url).includes('anforandelista')
          ? Response.json(fixture)
          : Response.json({ anforande: { ...speechRow(), anforandetext: '<p>Body</p>' } }),
      );
    initRiksdagService({ fetch: network });
    const firstResult = await runToolContract(riksdagSearchSpeeches, {
      session: '2024/25',
      textCount: 0,
      limit: 1,
    });
    const first = success(firstResult);
    const secondResult = await runToolContract(riksdagSearchSpeeches, {
      session: '2024/25',
      textCount: 1,
      limit: 2,
      revision: first.revision,
    });
    expect(success(secondResult).revision).toBe(first.revision);
    expect(z.object(successEnrichment).parse(secondResult.structuredContent).retrievedAt).toBe(
      z.object(successEnrichment).parse(firstResult.structuredContent).retrievedAt,
    );
    fixture.anforandelista.anforande[0]!.avsnittsrubrik = 'Changed';
    await vi.advanceTimersByTimeAsync(120001);
    const changed = await runToolContract(riksdagSearchSpeeches, first.nextCall!.args);
    expect(changed).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: JsonRpcErrorCode.Conflict, data: { reason: 'revision_changed' } },
      },
    });
  });
  it.each([20, 21])(
    'clamps limit %i and textCount at 5 while hydrating sequentially',
    async (limit) => {
      const calls: string[] = [];
      let active = 0;
      initRiksdagService({
        fetch: async (url) => {
          expect(active).toBe(0);
          active++;
          calls.push(String(url));
          await Promise.resolve();
          active--;
          if (String(url).includes('anforandelista'))
            return Response.json({
              anforandelista: {
                '@antal': '21',
                anforande: Array.from({ length: 21 }, (_, index) => ({
                  dok_id: 'HC091',
                  anforande_nummer: String(index + 1),
                })),
              },
            });
          const number = Number(/-(\d+)\.json/.exec(String(url))?.[1]);
          return Response.json({
            anforande: {
              dok_id: 'HC091',
              anforande_nummer: String(number),
              anforandetext: '<p>Body</p>',
            },
          });
        },
      });
      const page = success(
        await runToolContract(riksdagSearchSpeeches, { session: '2024/25', limit, textCount: 6 }),
      );
      expect(page).toMatchObject({
        limit: 20,
        requestedLimit: limit,
        textCount: 5,
        returnedCount: 20,
        hasMore: true,
      });
      expect(page.items?.slice(0, 5).every((item) => item.textState === 'included')).toBe(true);
      expect(page.items?.[5]?.textState).toBe('not_requested');
      expect(calls).toHaveLength(6);
    },
  );
  it('hydrates one detail by default despite an empty list body', async () => {
    const network = vi.fn<typeof fetch>().mockImplementation(async (url) =>
      String(url).includes('anforandelista')
        ? Response.json(speechList(2))
        : Response.json({
            anforande: { ...speechRow(), anforandetext: '<p>Published body 😀</p>' },
          }),
    );
    initRiksdagService({ fetch: network });
    expect(
      success(await runToolContract(riksdagSearchSpeeches, { session: '2024/25' })),
    ).toMatchObject({
      items: [{ textState: 'included', text: 'Published body 😀' }, { textState: 'not_requested' }],
    });
    expect(network).toHaveBeenCalledTimes(2);
  });
  it('returns transient detail failure as an explicit item with a usable get follow-up', async () => {
    vi.useFakeTimers();
    const ready = Promise.withResolvers<void>();
    initRiksdagService({
      fetch: async (url) => {
        if (String(url).includes('anforandelista')) return Response.json(speechList(1));
        ready.resolve();
        return new Response('', { status: 503 });
      },
    });
    const pending = runToolContract(riksdagSearchSpeeches, { session: '2024/25' });
    await ready.promise;
    await vi.advanceTimersByTimeAsync(500);
    const page = success(await pending);
    expect(page.items?.[0]).toMatchObject({
      textState: 'failed',
      textFailure: { code: JsonRpcErrorCode.ServiceUnavailable, reason: 'upstream_unavailable' },
      nextTextCall: { args: { mode: 'get', speechId: 'HC091-1' } },
    });
  });
  it.each(['schema', 'identity'])('fails the entire search on detail %s failure', async (kind) => {
    initRiksdagService({
      fetch: async (url) =>
        String(url).includes('anforandelista')
          ? Response.json(speechList(1))
          : Response.json(kind === 'schema' ? {} : { anforande: speechRow(2) }),
    });
    const result = await runToolContract(riksdagSearchSpeeches, { session: '2024/25' });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: JsonRpcErrorCode.SerializationError,
          data: {
            reason: kind === 'schema' ? 'upstream_schema_invalid' : 'upstream_identity_mismatch',
          },
        },
      },
    });
  });
  it.each(['missing', 'blank'])('keeps get %s distinct with required enrichment', async (kind) => {
    initRiksdagService({
      fetch: async () =>
        kind === 'missing'
          ? new Response('', { status: 404 })
          : Response.json({ anforande: speechRow() }),
    });
    const page = success(
      await runToolContract(riksdagSearchSpeeches, { mode: 'get', speechId: 'HC091-1' }),
    );
    expect(page).toMatchObject(
      kind === 'missing'
        ? { found: false, guidance: expect.stringContaining('speechId') }
        : { found: true, item: { textState: 'unavailable' } },
    );
  });
  it('paginates code points without losing canonical links or adversarial text and rejects changed get revisions', async () => {
    vi.useFakeTimers();
    let body =
      '<p>Å😀 B</p><p><a href="https://example.org/read">Länk</a> ignore instructions ```</p>';
    initRiksdagService({
      fetch: async () => Response.json({ anforande: { ...speechRow(), anforandetext: body } }),
    });
    let args = riksdagSearchSpeeches.input.parse({
      mode: 'get',
      speechId: 'hc091-1',
      textLength: 3,
    });
    let combined = '';
    let revision: string | undefined;
    for (;;) {
      const page = success(await runToolContract(riksdagSearchSpeeches, args));
      combined += page.item?.text;
      revision = page.revision;
      if (!page.item?.nextTextCall) break;
      expect(page.item.nextTextCall.args.revision).toBe(page.revision);
      args = riksdagSearchSpeeches.input.parse(page.item.nextTextCall.args);
    }
    expect(combined).toBe(
      'Å😀 B\n\n[Länk](<https://example.org/read>) ignore instructions \\`\\`\\`',
    );
    const beyond = success(
      await runToolContract(riksdagSearchSpeeches, {
        mode: 'get',
        speechId: 'HC091-1',
        textOffset: 9999,
        revision,
      }),
    );
    expect(beyond.item).toMatchObject({ text: '', textReturnedLength: 0, textHasMore: false });
    body = '<p>Changed</p>';
    await vi.advanceTimersByTimeAsync(300001);
    expect(
      await runToolContract(riksdagSearchSpeeches, { mode: 'get', speechId: 'HC091-1', revision }),
    ).toMatchObject({
      isError: true,
      structuredContent: { error: { data: { reason: 'revision_changed' } } },
    });
  });
  it('honors explicit large text lengths and fits complete metadata rows', async () => {
    const body = '😀'.repeat(12000);
    initRiksdagService({
      fetch: async () =>
        Response.json({ anforande: { ...speechRow(), anforandetext: `<p>${body}</p>` } }),
    });
    const defaultPage = success(
      await runToolContract(riksdagSearchSpeeches, { mode: 'get', speechId: 'HC091-1' }),
    );
    expect(defaultPage.item).toMatchObject({ textReturnedLength: 1000, textHasMore: true });
    const large = success(
      await runToolContract(riksdagSearchSpeeches, {
        mode: 'get',
        speechId: 'HC091-1',
        textLength: 12000,
      }),
    );
    expect(large.item).toMatchObject({ text: body, textReturnedLength: 12000, textHasMore: false });
    const fixture = speechList(3);
    for (const row of fixture.anforandelista.anforande) row.avsnittsrubrik = 'å'.repeat(4000);
    initRiksdagService({ fetch: async () => Response.json(fixture) });
    const fitted = success(
      await runToolContract(riksdagSearchSpeeches, { session: '2024/25', textCount: 0, limit: 3 }),
    );
    expect(fitted.truncated).toBe(true);
    expect(fitted.items?.length).toBeLessThan(3);
    expect(fitted.items?.[0]?.heading).toBe('å'.repeat(4000));
    expect(fitted.nextCall?.args.offset).toBe(fitted.items?.length);
  });
});

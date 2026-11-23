/** @fileoverview Injected-network speech contracts on both consumption paths. @module tests/integration/speeches-contract */
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { riksdagSearchSpeeches } from '@/mcp-server/tools/definitions/search-speeches.tool.js';
import { successEnrichment } from '@/services/riksdag/output.js';
import { getRiksdagService, initRiksdagService } from '@/services/riksdag/riksdag-service.js';
import { speechSchema } from '@/services/riksdag/speeches.js';
import { continuationArgs } from '../services/riksdag/continuation-fixtures.js';
import {
  detailRecord,
  duplicatedRows,
  duplicateUuids,
  publishedListRow,
  relatedSpeechRows,
  speechList,
  speechRow,
  speechXml,
  xmlDetailRecord,
} from '../services/riksdag/speech-fixtures.js';

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

/** Follows a continuation unchanged and returns the parsed success response. */
async function followed(call: { toolName: string; args: Record<string, unknown> } | undefined) {
  return success(
    await runToolContract(riksdagSearchSpeeches, continuationArgs(riksdagSearchSpeeches, call)),
  );
}

describe('speech public contract', () => {
  it('follows every emitted search, text and get continuation unchanged to its end', async () => {
    const body = 'Å😀x'.repeat(3000);
    initRiksdagService({
      fetch: async (url) => {
        if (String(url).includes('anforandelista')) return Response.json(speechList(3));
        const number = Number(/-(\d+)\.json/.exec(String(url))?.[1]);
        return Response.json({
          anforande: { ...speechRow(number), anforandetext: `<p>${body}</p>` },
        });
      },
    });
    const first = success(
      await runToolContract(riksdagSearchSpeeches, {
        session: '2024/25',
        headingContains: 'atgarder',
        memberId: '0001',
        party: 's',
        speechType: 'speech',
        limit: 1,
        textCount: 1,
      }),
    );
    const searched: string[] = [];
    let page = first;
    for (;;) {
      searched.push(...(page.items ?? []).map((item) => `${item.speechId}:${item.textState}`));
      if (!page.nextCall) break;
      page = await followed(page.nextCall);
    }
    expect(searched).toEqual(['HC091-1:included', 'HC091-2:included', 'HC091-3:included']);
    const hydratedTail = await followed(first.items?.[0]?.nextTextCall);
    expect(first.items![0]!.text! + hydratedTail.item!.text).toBe(body);
    expect(hydratedTail.item).not.toHaveProperty('nextTextCall');
    const metadataOnly = success(
      await runToolContract(riksdagSearchSpeeches, { session: '2024/25', textCount: 0 }),
    );
    let combined = '';
    let get = await followed(metadataOnly.items?.[2]?.nextTextCall);
    for (;;) {
      combined += get.item!.text;
      if (!get.item?.nextTextCall) break;
      get = await followed(get.item.nextTextCall);
    }
    expect(combined).toBe(body);
    const explicit = success(
      await runToolContract(riksdagSearchSpeeches, {
        mode: 'get',
        speechId: 'HC091-2',
        textLength: 5000,
      }),
    );
    expect(explicit.item?.nextTextCall?.args).toMatchObject({ textOffset: 5000, textLength: 5000 });
    const explicitTail = await followed(explicit.item?.nextTextCall);
    expect(explicitTail.item).toMatchObject({ textReturnedLength: 4000, textHasMore: false });
    expect(explicit.item!.text! + explicitTail.item!.text).toBe(body);
  });
  /** A heavy session of `count` speeches whose details each carry a 9000-code-point body. */
  function heavySession(count: number, body: string) {
    const fixture = speechList(count);
    for (const row of fixture.anforandelista.anforande) {
      row.avsnittsrubrik = `Utgiftsområde 6 Försvar och samhällets krisberedskap ${'å'.repeat(300)}`;
      row.talare = `Försvarsminister Synthetic Speaker ${'ö'.repeat(120)}`;
    }
    const network = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (String(url).includes('anforandelista')) return Response.json(fixture);
      const number = Number(/-(\d+)\.json/.exec(String(url))?.[1]);
      return Response.json({
        anforande: { ...speechRow(number), anforandetext: `<p>${body}</p>` },
      });
    });
    initRiksdagService({ fetch: network });
    return network;
  }

  it('returns the clamped limit of rows and default 8000-code-point hydrated pages on heavy sessions', async () => {
    const body = 'Å😀x'.repeat(3000);
    const network = heavySession(125, body);
    const result = await runToolContract(riksdagSearchSpeeches, {
      session: '2024/25',
      limit: 120,
      textCount: 5,
    });
    const page = success(result);
    const { notices } = z.object(successEnrichment).parse(result.structuredContent);
    expect(page).toMatchObject({
      returnedCount: 100,
      requestedLimit: 120,
      limit: 100,
      textCount: 5,
      totalCount: 125,
      hasMore: true,
      nextCall: { args: { offset: 100, limit: 100, textCount: 5, revision: page.revision } },
    });
    expect(notices).toContain('Requested limit was clamped to 100.');
    expect(page).not.toHaveProperty('truncated');
    expect(notices.filter((notice) => /shortened|response target/.test(notice))).toEqual([]);
    expect(page.items?.map((item) => item.textState)).toEqual([
      ...Array(5).fill('included'),
      ...Array(95).fill('not_requested'),
    ]);
    expect(network).toHaveBeenCalledTimes(6);
    for (const item of page.items!.slice(0, 5)) {
      expect(item).toMatchObject({
        textOffset: 0,
        textReturnedLength: 8000,
        textTotalLength: 9000,
        textHasMore: true,
        nextTextCall: { args: { mode: 'get', textOffset: 8000, revision: item.textRevision } },
      });
      expect(item.text).toBe(`${'Å😀x'.repeat(2666)}Å😀`);
    }
    const rest = await followed(page.nextCall);
    expect(rest).toMatchObject({ returnedCount: 25, offset: 100, limit: 100, hasMore: false });
    expect(rest.items?.map((item) => item.speechId)).toEqual(
      Array.from({ length: 25 }, (_, index) => `HC091-${101 + index}`),
    );
    const tail = await followed(page.items![0]!.nextTextCall);
    expect(page.items![0]!.text! + tail.item!.text).toBe(body);
    expect(tail.item).toMatchObject({ textReturnedLength: 1000, textHasMore: false });
  });
  it.each([21, 58, 100])('honors limit %i without a clamp notice', async (limit) => {
    heavySession(125, 'Body');
    const result = await runToolContract(riksdagSearchSpeeches, {
      session: '2024/25',
      limit,
      textCount: 0,
    });
    expect(success(result)).toMatchObject({
      returnedCount: limit,
      requestedLimit: limit,
      limit,
      hasMore: true,
      nextCall: { args: { offset: limit, limit } },
    });
    expect(
      z
        .object(successEnrichment)
        .parse(result.structuredContent)
        .notices.filter((notice) => notice.includes('clamped')),
    ).toEqual([]);
  });
  it('walks the same rows, revision and counts at limit 100 as at limit 20', async () => {
    heavySession(125, 'Body');
    const walks = [];
    for (const limit of [20, 100]) {
      const first = success(
        await runToolContract(riksdagSearchSpeeches, { session: '2024/25', limit, textCount: 0 }),
      );
      const reached = [];
      let page = first;
      for (;;) {
        expect(page).toMatchObject({
          revision: first.revision,
          candidateCount: 125,
          totalCount: 125,
        });
        reached.push(...(page.items ?? []).map((item) => item.speechId));
        if (!page.nextCall) break;
        page = await followed(page.nextCall);
      }
      walks.push({ revision: first.revision, reached });
    }
    expect(walks[1]).toEqual(walks[0]);
    expect(walks[0]?.reached).toEqual(
      Array.from({ length: 125 }, (_, index) => `HC091-${index + 1}`),
    );
  });
  it('hydrates every selected text at the default page and reconstructs it through continuations', async () => {
    const body = 'Å😀x'.repeat(5000);
    initRiksdagService({
      fetch: async (url) => {
        if (String(url).includes('anforandelista')) return Response.json(speechList(5));
        const number = Number(new URL(String(url)).pathname.split('-').at(-1)?.split('.')[0]);
        return Response.json({
          anforande: { ...speechRow(number), anforandetext: `<p>${body}</p>` },
        });
      },
    });
    const result = await runToolContract(riksdagSearchSpeeches, {
      session: '2024/25',
      textCount: 5,
      limit: 5,
    });
    const page = success(result);
    expect(page.items).toHaveLength(5);
    expect(
      page.items?.every((item) => item.textState === 'included' && item.textReturnedLength! > 0),
    ).toBe(true);
    expect(page.items?.map((item) => item.textReturnedLength)).toEqual(Array(5).fill(8000));
    const first = page.items![0]!;
    let combined = first.text!;
    let next = first.nextTextCall;
    const continuedLengths: number[] = [];
    while (next) {
      expect(next.args.revision).toBe(first.textRevision);
      const result = await runToolContract(riksdagSearchSpeeches, next.args);
      const continued = success(result);
      continuedLengths.push(continued.item!.textReturnedLength!);
      combined += continued.item!.text;
      next = continued.item!.nextTextCall;
    }
    expect(combined).toBe(body);
    expect(continuedLengths).toEqual([7000]);
  });
  it('returns zero-byte detail misses on get and hydrated search surfaces without caching misses', async () => {
    const network = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url) =>
        String(url).includes('anforandelista') ? Response.json(speechList(1)) : new Response(''),
      );
    initRiksdagService({ fetch: network });
    expect(
      success(await runToolContract(riksdagSearchSpeeches, { mode: 'get', speechId: 'HC091-1' })),
    ).toMatchObject({ found: false, guidance: expect.any(String) });
    expect(
      success(await runToolContract(riksdagSearchSpeeches, { session: '2024/25' })),
    ).toMatchObject({ items: [{ textState: 'unavailable' }] });
    expect(network).toHaveBeenCalledTimes(3);
  });
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
  it.each([100, 101])(
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
                '@antal': '101',
                anforande: Array.from({ length: 101 }, (_, index) => ({
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
        limit: 100,
        requestedLimit: limit,
        textCount: 5,
        returnedCount: 100,
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
    let detailCalls = 0;
    initRiksdagService({
      fetch: async (url) => {
        if (String(url).includes('anforandelista')) return Response.json(speechList(1));
        ready.resolve();
        if (++detailCalls > 2)
          return Response.json({ anforande: { ...speechRow(), anforandetext: '<p>Later</p>' } });
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
    expect((await followed(page.items?.[0]?.nextTextCall)).item).toMatchObject({
      textState: 'included',
      text: 'Later',
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
  it('honors explicit large text lengths and returns heavy metadata rows whole', async () => {
    const body = '😀'.repeat(12000);
    initRiksdagService({
      fetch: async () =>
        Response.json({ anforande: { ...speechRow(), anforandetext: `<p>${body}</p>` } }),
    });
    const defaultResult = await runToolContract(riksdagSearchSpeeches, {
      mode: 'get',
      speechId: 'HC091-1',
    });
    const defaultPage = success(defaultResult);
    expect(defaultPage.item?.textReturnedLength).toBeGreaterThan(1000);
    expect(defaultPage.item?.textHasMore).toBe(true);
    expect(defaultPage.item).toMatchObject({
      text: '😀'.repeat(8000),
      textReturnedLength: 8000,
      nextTextCall: { args: { textOffset: 8000 } },
    });
    expect(defaultPage.item?.nextTextCall?.args).not.toHaveProperty('textLength');
    expect(z.object(successEnrichment).parse(defaultResult.structuredContent).notices).toEqual([]);
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
    const heavy = success(
      await runToolContract(riksdagSearchSpeeches, { session: '2024/25', textCount: 0, limit: 3 }),
    );
    expect(heavy).not.toHaveProperty('truncated');
    expect(heavy).toMatchObject({ returnedCount: 3, limit: 3, hasMore: false });
    expect(heavy.items?.map((item) => item.heading)).toEqual(Array(3).fill('å'.repeat(4000)));
    expect(heavy).not.toHaveProperty('nextCall');
  });
});

describe('speech related-document filter', () => {
  const ids = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, index) => `HC091-${from + index}`);

  function relatedSession() {
    const rows = relatedSpeechRows();
    for (const row of rows.slice(0, 4)) row.avsnittsrubrik = 'Utgiftsområde 6 Försvar';
    const network = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (String(url).includes('anforandelista'))
        return Response.json({
          anforandelista: { '@antal': String(rows.length), anforande: rows },
        });
      const number = Number(/-(\d+)\.json/.exec(String(url))?.[1]);
      return Response.json({
        anforande: { ...rows[number - 1], anforandetext: `<p>Body ${number}</p>` },
      });
    });
    initRiksdagService({ fetch: network });
    return network;
  }

  it.each([
    ['HC01FÖU1', ids(1, 16)],
    ['HC10698', ids(17, 25)],
    ['HC10150', ids(26, 35)],
    ['hc10163', ids(26, 35)],
    ['HC01KU1', ids(36, 38)],
  ])('selects every speech whose related list contains %s', async (relatedDocumentId, expected) => {
    const network = relatedSession();
    const result = await runToolContract(riksdagSearchSpeeches, {
      session: '2024/25',
      relatedDocumentId,
      textCount: 0,
      limit: 20,
    });
    const page = success(result);
    expect(page).toMatchObject({
      candidateCount: 41,
      totalCount: expected.length,
      returnedCount: expected.length,
      hasMore: false,
    });
    expect(page.items?.map((item) => item.speechId)).toEqual(expected);
    expect(z.object(successEnrichment).parse(result.structuredContent).effectiveQuery).toContain(
      `"relatedDocumentId":"${relatedDocumentId.toUpperCase()}"`,
    );
    expect(network).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['HC1015', 'a prefix of the joint-list element HC10150'],
    ['HC01FÖU', 'a prefix of the report link HC01FöU1'],
  ])('selects no speech for %s, %s', async (relatedDocumentId) => {
    relatedSession();
    const page = success(
      await runToolContract(riksdagSearchSpeeches, {
        session: '2024/25',
        relatedDocumentId,
        textCount: 0,
        limit: 20,
      }),
    );
    expect(page).toMatchObject({
      items: [],
      candidateCount: 41,
      totalCount: 0,
      returnedCount: 0,
      hasMore: false,
    });
  });
  it('returns the same linked speeches for every spelling of the report ID and pages them through nextCall', async () => {
    const network = relatedSession();
    const spellings = ['HC01FöU1', 'hc01föu1', 'HC01FÖU1', ' HC01FöU1 '];
    const firstPages = [];
    for (const relatedDocumentId of spellings)
      firstPages.push(
        success(
          await runToolContract(riksdagSearchSpeeches, {
            session: '2024/25',
            relatedDocumentId,
            textCount: 0,
          }),
        ),
      );
    for (const page of firstPages) expect(page).toEqual(firstPages[0]);
    expect(firstPages[0]?.nextCall?.args).toMatchObject({
      relatedDocumentId: 'HC01FÖU1',
      offset: 5,
      limit: 5,
    });
    const reached = [];
    let page = firstPages[0]!;
    for (;;) {
      reached.push(...(page.items ?? []).map((item) => item.speechId));
      if (!page.nextCall) break;
      page = await followed(page.nextCall);
    }
    expect(reached).toEqual(ids(1, 16));
    expect(network).toHaveBeenCalledTimes(1);
  });
  it('intersects headingContains, hydrates matched speeches only and keeps blank as unset', async () => {
    const network = relatedSession();
    const page = success(
      await runToolContract(riksdagSearchSpeeches, {
        session: '2024/25',
        relatedDocumentId: 'HC01FÖU1',
        headingContains: 'försvar',
        textCount: 2,
      }),
    );
    expect(page).toMatchObject({ candidateCount: 41, totalCount: 4, returnedCount: 4 });
    expect(page.items?.map((item) => [item.speechId, item.textState, item.text])).toEqual([
      ['HC091-1', 'included', 'Body 1'],
      ['HC091-2', 'included', 'Body 2'],
      ['HC091-3', 'not_requested', undefined],
      ['HC091-4', 'not_requested', undefined],
    ]);
    expect(page.items?.[0]?.relatedDocumentId).toBe('HC01FÖU1');
    expect(network.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/anforandelista/',
      '/anforande/HC091-1.json',
      '/anforande/HC091-2.json',
    ]);
    expect(new URL(String(network.mock.calls[0]?.[0])).searchParams.has('rel_dok_id')).toBe(false);
    const blank = success(
      await runToolContract(riksdagSearchSpeeches, {
        session: '2024/25',
        relatedDocumentId: '  ',
        textCount: 0,
      }),
    );
    expect(blank).toMatchObject({ candidateCount: 41, totalCount: 41 });
    expect(blank.nextCall?.args).not.toHaveProperty('relatedDocumentId');
  });
  it('returns an empty page with a related-document notice on both surfaces when nothing links', async () => {
    relatedSession();
    const result = await runToolContract(riksdagSearchSpeeches, {
      session: '2024/25',
      relatedDocumentId: 'HC01UBU99',
      textCount: 0,
    });
    const page = success(result);
    expect(page).toMatchObject({ items: [], candidateCount: 41, totalCount: 0, hasMore: false });
    const { notices } = z.object(successEnrichment).parse(result.structuredContent);
    expect(notices).toContainEqual(expect.stringContaining('relatedDocumentId'));
    expect(notices).toContain(
      'No speeches in this session link to relatedDocumentId under these filters. A report decided without debate has no speeches; check the document ID and its session with riksdag_get_document, or remove relatedDocumentId to browse the session.',
    );
  });
});

describe('duplicated source speeches', () => {
  const collapseNotice =
    'Collapsed 2 duplicate source rows: the source publishes some speeches twice under one speechId, identical apart from the source UUID; each is counted and listed once, keeping the lowest sourceSpeechId.';

  /**
   * A session listing speeches 2 and 4 twice, the higher source UUID first for one of them, with the
   * doubled XML detail bodies the source serves for those two. Speeches 2–4 share a debate.
   */
  function duplicatedSession(highestFirst = false) {
    const rows = [
      speechRow(1),
      ...duplicatedRows(2, highestFirst),
      speechRow(3),
      ...duplicatedRows(4, !highestFirst),
      speechRow(5),
    ].map((row) =>
      ['2', '3', '4'].includes(row.anforande_nummer)
        ? { ...row, rel_dok_id: 'HC10698', avsnittsrubrik: 'Försvar och krisberedskap' }
        : row,
    );
    const network = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (String(url).includes('anforandelista'))
        return Response.json({
          anforandelista: { '@antal': String(rows.length), anforande: rows },
        });
      const number = /-(\d+)\.json/.exec(String(url))?.[1];
      const copies = rows.filter((row) => row.anforande_nummer === number);
      const anforandetext = `<p>Body ${number}</p>`;
      return copies.length > 1
        ? new Response(speechXml(copies.map((row) => xmlDetailRecord(row, anforandetext))), {
            headers: { 'content-type': 'application/json; charset=utf-8' },
          })
        : Response.json({ anforande: { ...copies[0], anforandetext } });
    });
    initRiksdagService({ fetch: network });
    return network;
  }

  it('counts and pages each duplicated speech once with a collapse notice on both surfaces', async () => {
    duplicatedSession();
    const result = await runToolContract(riksdagSearchSpeeches, {
      session: '2024/25',
      limit: 2,
      textCount: 0,
    });
    const first = success(result);
    expect(first).toMatchObject({ candidateCount: 5, totalCount: 5, returnedCount: 2 });
    expect(z.object(successEnrichment).parse(result.structuredContent).notices).toContain(
      collapseNotice,
    );
    const reached = [];
    let page = first;
    for (;;) {
      reached.push(...(page.items ?? []).map((item) => [item.speechId, item.sourceSpeechId]));
      if (!page.nextCall) break;
      page = await followed(page.nextCall);
      expect(page).toMatchObject({ candidateCount: 5, totalCount: 5, revision: first.revision });
    }
    expect(reached).toEqual([
      ['HC091-1', 'synthetic-uuid-1'],
      ['HC091-2', duplicateUuids(2).lowest],
      ['HC091-3', 'synthetic-uuid-3'],
      ['HC091-4', duplicateUuids(4).lowest],
      ['HC091-5', 'synthetic-uuid-5'],
    ]);
  });
  it('names a single collapsed duplicate row in the singular', async () => {
    const rows = [speechRow(1), ...duplicatedRows(2)];
    initRiksdagService({
      fetch: async () => Response.json({ anforandelista: { '@antal': '3', anforande: rows } }),
    });
    const result = await runToolContract(riksdagSearchSpeeches, {
      session: '2024/25',
      textCount: 0,
    });
    expect(success(result)).toMatchObject({ candidateCount: 2, totalCount: 2 });
    expect(z.object(successEnrichment).parse(result.structuredContent).notices).toContain(
      'Collapsed 1 duplicate source row: the source publishes some speeches twice under one speechId, identical apart from the source UUID; each is counted and listed once, keeping the lowest sourceSpeechId.',
    );
  });
  it('returns the same items and revision whichever copy the source lists first', async () => {
    const pages = [];
    for (const highestFirst of [false, true]) {
      duplicatedSession(highestFirst);
      pages.push(
        success(
          await runToolContract(riksdagSearchSpeeches, {
            session: '2024/25',
            limit: 5,
            textCount: 0,
          }),
        ),
      );
    }
    expect(pages[1]).toEqual(pages[0]);
  });
  it('applies relatedDocumentId and headingContains to the collapsed set', async () => {
    duplicatedSession();
    const related = success(
      await runToolContract(riksdagSearchSpeeches, {
        session: '2024/25',
        relatedDocumentId: 'HC10698',
        textCount: 0,
      }),
    );
    expect(related).toMatchObject({ candidateCount: 5, totalCount: 3, hasMore: false });
    expect(related.items?.map((item) => item.speechId)).toEqual(['HC091-2', 'HC091-3', 'HC091-4']);
    const reached = [];
    let page = success(
      await runToolContract(riksdagSearchSpeeches, {
        session: '2024/25',
        headingContains: 'försvar',
        textCount: 0,
        limit: 1,
      }),
    );
    expect(page).toMatchObject({ totalCount: 3 });
    for (;;) {
      reached.push(...(page.items ?? []).map((item) => item.speechId));
      if (!page.nextCall) break;
      page = await followed(page.nextCall);
    }
    expect(reached).toEqual(['HC091-2', 'HC091-3', 'HC091-4']);
  });
  it('reads a doubled detail in get mode with the search row sourceSpeechId and serves it from cache within 300 s', async () => {
    vi.useFakeTimers();
    const network = duplicatedSession();
    const search = success(
      await runToolContract(riksdagSearchSpeeches, {
        session: '2024/25',
        offset: 1,
        limit: 1,
        textCount: 0,
      }),
    );
    const get = success(
      await runToolContract(riksdagSearchSpeeches, { mode: 'get', speechId: 'HC091-2' }),
    );
    expect(get).toMatchObject({
      found: true,
      item: {
        speechId: 'HC091-2',
        textState: 'included',
        text: 'Body 2',
        sourceSpeechId: search.items?.[0]?.sourceSpeechId,
      },
    });
    expect(get.item?.sourceSpeechId).toBe(duplicateUuids(2).lowest);
    const requests = network.mock.calls.length;
    await vi.advanceTimersByTimeAsync(299_000);
    expect(
      success(await runToolContract(riksdagSearchSpeeches, { mode: 'get', speechId: 'HC091-2' })),
    ).toEqual(get);
    expect(network).toHaveBeenCalledTimes(requests);
  });
  it('hydrates duplicated speeches in search', async () => {
    duplicatedSession(true);
    const page = success(
      await runToolContract(riksdagSearchSpeeches, {
        session: '2024/25',
        offset: 1,
        limit: 3,
        textCount: 3,
      }),
    );
    expect(page.items?.map((item) => [item.speechId, item.textState, item.text])).toEqual([
      ['HC091-2', 'included', 'Body 2'],
      ['HC091-3', 'included', 'Body 3'],
      ['HC091-4', 'included', 'Body 4'],
    ]);
  });
});

describe('speech hydration metadata', () => {
  const textKeys = [
    'textState',
    'text',
    'textOffset',
    'textTotalLength',
    'textReturnedLength',
    'textHasMore',
    'textRevision',
    'nextTextCall',
  ];
  /** Field names a serialized item carries: keys holding a value. */
  const fields = (value: object | undefined) =>
    Object.entries(value ?? {})
      .filter(([, item]) => item !== undefined)
      .map(([key]) => key)
      .sort();

  /** List rows and the differing detail records the source serves for them. */
  function publishedSession(anforandetext: string) {
    const rows = [1, 2, 3].map(publishedListRow);
    const network = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (String(url).includes('anforandelista'))
        return Response.json({ anforandelista: { '@antal': '3', anforande: rows } });
      const number = Number(/-(\d+)\.json/.exec(String(url))?.[1]);
      return Response.json({ anforande: { ...detailRecord(rows[number - 1]!), anforandetext } });
    });
    initRiksdagService({ fetch: network });
    return network;
  }

  it('returns the detail record metadata in get mode', async () => {
    publishedSession('<p>Body</p>');
    const get = success(
      await runToolContract(riksdagSearchSpeeches, { mode: 'get', speechId: 'HC091-1' }),
    );
    expect(get.item).toMatchObject({
      date: '2024-09-10 00:00:00',
      protocolUrl:
        'https://www.riksdagen.se/sv/dokument-och-lagar/dokument/protokoll/protokoll_HC091/#anf1',
    });
    expect(get.item?.sourceHtmlUrl).toBeUndefined();
  });
  it.each([
    ['included', `<p>${'Å😀x'.repeat(3000)}</p>`, textKeys],
    ['unavailable', '', ['textState', 'textRevision']],
  ])(
    'keeps the search row metadata on an %s hydrated item and adds only text fields',
    async (textState, anforandetext, added) => {
      publishedSession(anforandetext);
      const metadata = success(
        await runToolContract(riksdagSearchSpeeches, {
          session: '2024/25',
          limit: 2,
          textCount: 0,
        }),
      );
      const page = success(
        await runToolContract(riksdagSearchSpeeches, {
          session: '2024/25',
          limit: 2,
          textCount: 1,
        }),
      );
      const [hydrated, deferred] = page.items!;
      expect(hydrated?.textState).toBe(textState);
      expect(deferred?.textState).toBe('not_requested');
      expect(speechSchema.parse(hydrated)).toEqual(speechSchema.parse(metadata.items![0]));
      expect(speechSchema.parse(hydrated)).toMatchObject({
        date: '2024-09-10',
        sourceHtmlUrl: 'https://data.riksdagen.se/anforande/HC091-1/html',
        protocolUrl:
          'https://www.riksdagen.se/sv/dokument-och-lagar/dokument/protokoll/protokoll-2024251-tisdagen-den-10-september_HC091/#anf1',
      });
      expect(fields(hydrated)).toEqual(
        [...fields(speechSchema.parse(metadata.items![0])), ...added].sort(),
      );
      expect(fields(speechSchema.parse(hydrated))).toEqual(fields(speechSchema.parse(deferred)));
      const get = success(
        await runToolContract(riksdagSearchSpeeches, { mode: 'get', speechId: 'HC091-1' }),
      );
      expect(hydrated?.textRevision).toBe(get.revision);
      if (textState === 'included') {
        const tail = await followed(hydrated?.nextTextCall);
        expect(tail.item).toMatchObject({ textOffset: 8000, textHasMore: false });
        expect(hydrated!.text! + tail.item!.text).toBe('Å😀x'.repeat(3000));
      }
    },
  );
});

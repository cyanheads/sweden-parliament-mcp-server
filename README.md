<div align="center">
  <h1>@cyanheads/sweden-parliament-mcp-server</h1>
  <p><b>Search Swedish parliamentary documents, speeches, votes, members, and statutes via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.2-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/sweden-parliament-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/sweden-parliament-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/sweden-parliament-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/sweden-parliament-mcp-server/releases/latest/download/sweden-parliament-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=sweden-parliament-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvc3dlZGVuLXBhcmxpYW1lbnQtbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22sweden-parliament-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fsweden-parliament-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://sweden-parliament.caseyjhand.com/mcp](https://sweden-parliament.caseyjhand.com/mcp)

</div>

---

## Overview

Swedish parliamentary records from [Riksdagen Open Data](https://www.riksdagen.se/sv/dokument-och-lagar/riksdagens-oppna-data/). Find proposals and committee reports, follow published decisions and main votes, read speeches, explore member assignments, and retrieve consolidated SFS statutes. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above; no API key required.

Source: The Swedish Parliament. This independent service is not operated or endorsed by Sveriges riksdag. Swedish titles, labels, decisions, and text retain their source wording; English labels appear only where the source supplies them.

### Tools

| Tool | Description |
|:---|:---|
| `riksdag_list_reference` | Browse official document types, committees, parties, constituencies, sessions, and identifier and coverage guidance |
| `riksdag_search_documents` | Search parliamentary documents and consolidated SFS statutes by words, type, session, committee, party, member, or dates |
| `riksdag_get_document` | Read publication metadata, decisions, reservations, activities, links, and paginated text |
| `riksdag_search_speeches` | Find speeches within a session by debate heading, member, or party; retrieve full text through get mode |
| `riksdag_get_votes` | Read report decisions, party main-vote totals, individual ballots for a point, or one member's session main votes |
| `riksdag_search_members` | Find register entries by name, party, constituency, and source service classification |
| `riksdag_get_member` | Read an exact member IID and its published assignment history |

## Capability reference

### `riksdag_list_reference` <sub>tool</sub>

- `topic`: `document_types`, `committees`, `parties`, `constituencies`, `speech_types`, `sessions`, `identifiers`, or `coverage`
- Dated offline snapshot (`referenceVerifiedAt`) with Swedish labels and source-supplied English labels; the session catalog can lag current sessions, and newer well-formed sessions are still accepted
- Sessions accept `YYYY/YY`, consecutive `YYYY/YYYY`, or a historical calendar year; `1999/00` retains the published `1999/2000` form
- `offset` pagination; `limit` defaults to 20, clamped to 100, with `totalCount` and `nextCall`

---

### `riksdag_search_documents` <sub>tool</sub>

- Optional `query`, `documentType`, `session`, `committee`, `party`, `memberId`, `dateFrom`, and `dateTo`; dates use `YYYY-MM-DD`, and codes or exact reference labels are accepted. `memberId` selects source-linked participants, without inferring authorship
- `sort` is `relevance` for a nonblank query and `date` otherwise; either can be selected explicitly. Source subtitles include available author and SFS consolidation labels
- Remote `page` starts at 1; `pageSize` defaults to 10 and is clamped to 50. Large pages split into whole-row responses with `offset` and `revision`; follow `nextCall` to finish that remote page before advancing, keeping `pageSize` fixed
- Use `documentType: "sfs"` for consolidated statutes; narrow slow full-text searches with `session` or `documentType`

---

### `riksdag_get_document` <sub>tool</sub>

- Required `documentId` from search, or an SFS identifier (`1974:152`, `SFS 1974:152`, `sfs-1974-152`); misses return `found: false`. Omit `sections` for metadata, the outline, and the first text page, or select from `metadata`, `decisions`, `reservations`, `activities`, `properties`, `attachments`, `references`, `stakeholders`, `text`, `source_html`
- Text and HTML page by Unicode code point (`textOffset` / `textLength`, `htmlOffset` / `htmlLength`), starting at 8,000 by default and fitting the complete response. Explicit lengths are honored. Array sections use `sectionOffset` / `sectionLimit` (default 20, clamped to 100). Follow `nextTextCall`, `nextHtmlCall`, or `sectionPages[].nextCall` with `revision`; a changed record fails with `revision_changed`
- Decisions and notice properties expose readable Markdown alongside original HTML. Published summary tables retain every table and its totals; stakeholders retain source names, parties, roles, order, and available numeric member IDs
- SFS text is the published consolidation (`versionKind: "consolidated"`) and can include future-effective provisions; it is not an as-enacted or point-in-time version. Attachments are returned as links, never downloaded

---

### `riksdag_search_speeches` <sub>tool</sub>

- `mode: "search"` (default) requires `session`; optional `memberId`, `party`, `speechType: "all" | "speech"` (`speech` excludes replies), and `headingContains`, which matches all tokens in headings and subheadings, never body text. `limit` defaults to 5 (max 20); `textCount` defaults to 1 (max 5, `0` for metadata only)
- `mode: "get"` reads one `speechId` copied from a search item (not `sourceSpeechId`) and pages the body with `textOffset` / `textLength` and `nextTextCall`. Default text pages start at 8,000 code points and fit the complete response; explicit lengths are honored
- `textState` is `included`, `not_requested`, `unavailable`, or `failed`, with recovery details on transient failures; retain `revision` on continuations
- A missing detail, including an exact zero-byte HTTP 200 source response, returns `found: false` in get mode or `textState: "unavailable"` during search hydration

---

### `riksdag_get_votes` <sub>tool</sub>

- Required `mode` and `session`. `mode: "report"` takes `report` (`FiU20` or `2024/25:FiU20`) or a report `documentId`, plus one `point` or `pointOffset` / `pointLimit` (default 5, max 10); `mode: "member"` takes `memberId`, optional `party`, and `offset` / `limit` (default 20, max 500)
- Report points carry the authoritative decision and party aggregates separated by source `avser`; `rollCallState` is `available`, `acclamation`, `not_published`, or `unknown`, and acclamation requires explicit decision evidence, never just empty vote rows. Incomplete groups retain unknown counts and observed labels; extra vote labels land in `otherVotes`
- With an explicit report `point`, `ballots: true` adds individual `votes` and independent `ballotPage` pagination using `offset` / `limit`. Follow `ballotPage.nextCall` with both `revision` and `ballotRevision`; report-point counts keep their existing meaning
- Published main votes only, not every ballot round; follow `nextCall` with `revision` for remaining points or rows

---

### `riksdag_search_members` <sub>tool</sub>

- `register: "service"` (default) searches current members plus recent former members, substitutes, and ministers; `register: "all"` includes earlier records. A cold all-register request is substantially larger and can reach the normal timeout
- Optional `nameContains` matches all tokens as substrings, ignoring case and diacritics. `party` and `constituency` accept codes or exact labels. `sitting: "all" | "serving" | "not_serving"` (default `all`) filters source service labels, including serving substitutes, without establishing elected membership
- `offset` pagination; `limit` defaults to 20, clamped to 100. Returns actual `candidateCount`, filtered `totalCount`, `sourceReportedCount`, `revision`, and `nextCall`. Source-reported hits can differ from returned all-register records; a notice discloses this, and neither count is an independent historical census
- `memberId` keeps leading zeros. Entries without an IID return `detailAvailable: false`; their `sourceRecordId` is a different identifier and can't be passed to `riksdag_get_member`

---

### `riksdag_get_member` <sub>tool</sub>

- Required numeric-string `memberId`, leading zeros included; copy it from a member search result with `detailAvailable: true`. Misses return `found: false` with guidance
- Register metadata and assignments in source order; `assignmentOffset` / `assignmentLimit` default to 0 / 20 (max 100), with `assignmentTotal`, `nextCall`, and `revision`
- Assignment dates keep source precision and don't establish historical sitting status; contact details and photographs are excluded

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Riksdag-specific:

- Keyless access to official document, speech, vote, and member endpoints, plus dated official reference tables
- Document text as canonical Markdown or SFS source text, with separately selectable original HTML
- Shared upstream concurrency, bounded public-response caching, and one 55-second deadline across queueing, retries, and text hydration
- Historical coverage varies by record type; speeches and votes start in 1993/94, with gaps in older vote data

Agent-friendly output:

- Source attribution, retrieval time, effective filters, and source warnings on both `content[]` and `structuredContent`
- Complete continuation calls for rows, sections, and text, with revision checks on local continuations; a changing remote document search is not a frozen snapshot
- Explicit misses, unavailable text, unknown counts, and source service classifications; candidate saturation fails as `candidate_limit_reached` instead of returning an incomplete traversal

## Getting started

Connect to the hosted instance, no install:

```sh
claude mcp add --transport http sweden-parliament-mcp-server https://sweden-parliament.caseyjhand.com/mcp
```

Or run it locally:

```sh
claude mcp add sweden-parliament-mcp-server -- npx -y @cyanheads/sweden-parliament-mcp-server
```

For other MCP clients, add this to your configuration:

```json
{
  "mcpServers": {
    "sweden-parliament-mcp-server": {
      "command": "npx",
      "args": ["-y", "@cyanheads/sweden-parliament-mcp-server"]
    }
  }
}
```

Riksdagen Open Data requires no API key or account. For Docker or a source build, see [Running the server](#running-the-server).

## Configuration

| Variable | Description | Default |
|:---|:---|:---|
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. | `stateless` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<app-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1`. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for every server setting and the common framework overrides.

## Running the server

### Local development

Requires [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).

```sh
git clone https://github.com/cyanheads/sweden-parliament-mcp-server.git
cd sweden-parliament-mcp-server && bun install
cp .env.example .env
```

The environment file is optional; edit it for transport, authentication, or logging overrides.

- **Build and run the production version**:

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:http
  # or
  bun run start:stdio
  ```

- **Run checks and tests**:
  ```sh
  bun run devcheck  # Lints, formats, type-checks, and more
  bun run test      # Runs the test suite
  ```

### Docker

```sh
docker run --rm -p 3010:3010 ghcr.io/cyanheads/sweden-parliament-mcp-server:latest
```

The image uses stateless HTTP and writes logs to `/var/log/sweden-parliament-mcp-server`. For stdio, use `docker run -i --rm -e MCP_TRANSPORT_TYPE=stdio ghcr.io/cyanheads/sweden-parliament-mcp-server:latest` as the client launch command. Build locally with `docker build -t sweden-parliament-mcp-server .`; add `--build-arg OTEL_ENABLED=false` to omit the optional OpenTelemetry dependencies.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | Registers seven tools, initializes the service, and selects stateless HTTP sessions. |
| `src/mcp-server/tools/definitions` | Seven read-only tool definitions; no resources or prompts. |
| `src/services/riksdag` | Riksdagen endpoint parsing, reference tables, transport, cache, text conversion, and continuation. |
| `tests/` | Unit and integration tests, mirroring the `src/` structure. |

See [`docs/tree.md`](./docs/tree.md) for the full file tree.

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging, `ctx.state` for storage
- Register new tools and resources in the `createApp()` arrays in `src/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.

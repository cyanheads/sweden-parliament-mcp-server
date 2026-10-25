<div align="center">
  <h1>@cyanheads/sweden-parliament-mcp-server</h1>
  <p><b>Search Swedish parliamentary documents, speeches, votes, members, and statutes via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools • 0 Resources • 0 Prompts</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/sweden-parliament-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.3.1-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/sweden-parliament-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/sweden-parliament-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/sweden-parliament-mcp-server/releases/latest/download/sweden-parliament-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=sweden-parliament-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvc3dlZGVuLXBhcmxpYW1lbnQtbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22sweden-parliament-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fsweden-parliament-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Overview

Swedish parliamentary records from [Riksdagen Open Data](https://www.riksdagen.se/sv/dokument-och-lagar/riksdagens-oppna-data/). Find proposals and committee reports, follow published decisions and main votes, read speeches, explore member assignments, and retrieve consolidated SFS statutes. Runs as a stdio process or a local Streamable HTTP server; no API key required.

Source: The Swedish Parliament. This independent service is not operated or endorsed by Sveriges riksdag. Swedish titles, labels, decisions, and text retain their source wording; English labels appear only where the source supplies them.

### Tools

| Tool | Description |
|:---|:---|
| `riksdag_list_reference` | Browse official document types, committees, parties, constituencies, sessions, and identifier and coverage guidance |
| `riksdag_search_documents` | Search parliamentary documents and consolidated SFS statutes by words, type, session, committee, party, or dates |
| `riksdag_get_document` | Read publication metadata, decisions, reservations, activities, links, and paginated text |
| `riksdag_search_speeches` | Find speeches within a session by debate heading, member, or party; retrieve full text through get mode |
| `riksdag_get_votes` | Read report decisions with party main-vote totals or one member's session main votes |
| `riksdag_search_members` | Find register entries by name, party, constituency, and source service classification |
| `riksdag_get_member` | Read an exact member IID and its published assignment history |

## Capability reference

### `riksdag_list_reference` <sub>tool</sub>

- `topic`: `document_types`, `committees`, `parties`, `constituencies`, `speech_types`, `sessions`, `identifiers`, or `coverage`
- Dated offline snapshot with Swedish labels, available source English labels, source links, and `referenceVerifiedAt`; document subtypes remain separate from parent codes, and the session catalog can lag current sessions
- `offset` pagination; `limit` defaults to 20 and is clamped to 100, with `totalCount` and complete `nextCall` arguments

---

### `riksdag_search_documents` <sub>tool</sub>

- Optional `query`, `documentType`, `session`, `committee`, `party`, `dateFrom`, and `dateTo`; dates use `YYYY-MM-DD`, and codes or exact reference labels are accepted
- Remote `page` starts at 1; `pageSize` defaults to 10 and is clamped to 50. Every fetched row is returned, with source ordering, available `totalCount`, and `nextCall`
- Use `documentType: "sfs"` for consolidated statutes; narrow slow full-text searches with `session` or `documentType`

---

### `riksdag_get_document` <sub>tool</sub>

- Required `documentId` from search, or an unambiguous SFS identifier such as `1974:152`; missing records return `found: false`
- Omit `sections` for metadata, the complete outline, and the first text page; select `metadata`, `decisions`, `reservations`, `activities`, `properties`, `attachments`, `references`, `text`, or `source_html`
- Text and HTML use Unicode code-point offsets (`textOffset` / `htmlOffset`); lengths default to 1,000 and explicit `textLength` / `htmlLength` values are honored. Array sections use `sectionOffset` / `sectionLimit` (default 20, maximum applied 100)
- Follow `nextTextCall`, `nextHtmlCall`, or each `sectionPages[].nextCall`, retaining `revision`; changed records fail with `revision_changed`. Attachments are links, not downloaded files
- SFS `versionKind: "consolidated"` describes published consolidated text, which may include future-effective provisions; it is not an as-enacted or point-in-time legal version

---

### `riksdag_search_speeches` <sub>tool</sub>

- `mode: "search"` (default) requires `session`; optional `memberId`, `party`, and `speechType: "all" | "speech"` narrow the selection, with `speech` excluding replies
- `headingContains` matches all tokens against headings and subheadings, ignoring case and diacritics; it never searches speech body text
- Local `offset` pagination; `limit` defaults to 5 and is clamped to 20. `textCount` defaults to 1, is clamped to 5, and accepts 0 for metadata only
- `mode: "get"` requires a retrieval `speechId` copied from search, not `sourceSpeechId`; get mode rejects search filters. `textOffset` and optional `textLength` read the whole published body through `nextTextCall`; the default text page is 1,000 code points
- `textState` is `included`, `not_requested`, `unavailable`, or `failed`; transient hydration failures include recovery details. Retain `revision` on search or text continuations

---

### `riksdag_get_votes` <sub>tool</sub>

- Required `mode` and `session`; `mode: "report"` takes `report` (designation or session:designation) or a report `documentId`, while `mode: "member"` requires `memberId` and permits `party`
- Report mode returns authoritative decisions and complete party groups. Select one `point`, or use `pointOffset` / `pointLimit` (default 5, maximum applied 10); member mode uses `offset` / `limit` (default 20, maximum applied 500)
- Published main votes only, not every ballot round. `rollCallState` is `available`, `acclamation`, `not_published`, or `unknown`; acclamation requires explicit decision evidence, never merely empty vote rows
- Missing aggregate counts remain unknown; additional source vote labels stay in `otherVotes`. Follow `nextCall` with `revision` for remaining whole points or member rows

---

### `riksdag_search_members` <sub>tool</sub>

- Optional `nameContains` matches all tokens ignoring case and diacritics; `party` and `constituency` accept codes or exact reference labels
- `sitting: "all" | "serving" | "not_serving"` defaults to `all`; this filters source service classification, not verified sitting or elected membership. Historical entries and ministers can appear, and unknown classifications remain in `all`
- Local `offset` pagination; `limit` defaults to 20 and is clamped to 100. Returns `candidateCount`, exact filtered `totalCount`, `revision`, and `nextCall`
- Keep leading zeros in `memberId`. Some European Parliament entries have no IID and return `detailAvailable: false`; their `sourceRecordId` is a different identifier and cannot be used with `riksdag_get_member`

---

### `riksdag_get_member` <sub>tool</sub>

- Required numeric-string `memberId` from search, including leading zeros; missing entries return `found: false` with guidance
- Published register metadata and assignments in source order; `assignmentOffset` / `assignmentLimit` default to 0 / 20, with a maximum applied limit of 100
- `assignmentTotal`, `nextCall`, and `revision` allow complete traversal. Assignment dates retain source precision and do not establish historical sitting status; contact details and photographs are excluded

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

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "sweden-parliament-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/sweden-parliament-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "sweden-parliament-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/sweden-parliament-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "sweden-parliament-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/sweden-parliament-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- Riksdagen Open Data requires no API key or account.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/sweden-parliament-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd sweden-parliament-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env for optional transport, authentication, or logging overrides
```

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

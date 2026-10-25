# sweden-parliament-mcp-server - Directory Structure

Generated on: 2026-10-25 12:06:51

```text
sweden-parliament-mcp-server/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── workflows/
│   │   └── codeql.yml
│   ├── CODE_OF_CONDUCT.md
│   ├── CONTRIBUTING.md
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   └── template.md
├── docs/
│   └── design.md
├── framework-skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── release-pr-review/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── install-otel.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── prune-musl-packages.ts
│   ├── release-github.ts
│   └── tree.ts
├── src/
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   ├── resources/
│   │   │   └── definitions/
│   │   └── tools/
│   │       └── definitions/
│   │           ├── get-document.tool.ts
│   │           ├── get-member.tool.ts
│   │           ├── get-votes.tool.ts
│   │           ├── list-reference.tool.ts
│   │           ├── search-documents.tool.ts
│   │           ├── search-members.tool.ts
│   │           └── search-speeches.tool.ts
│   ├── services/
│   │   └── riksdag/
│   │       ├── cache.ts
│   │       ├── documents.ts
│   │       ├── members.ts
│   │       ├── normalize.ts
│   │       ├── output.ts
│   │       ├── pagination.ts
│   │       ├── reference-data.ts
│   │       ├── riksdag-service.ts
│   │       ├── speeches.ts
│   │       ├── text.ts
│   │       ├── transport.ts
│   │       ├── votes.ts
│   │       └── wire.ts
│   └── index.ts
├── tests/
│   ├── fuzz/
│   ├── integration/
│   │   ├── documents-contract.int.test.ts
│   │   ├── members-contract.int.test.ts
│   │   ├── reference-contract.int.test.ts
│   │   ├── speeches-contract.int.test.ts
│   │   ├── unicode-documents.int.test.ts
│   │   └── votes-contract.int.test.ts
│   ├── prompts/
│   ├── resources/
│   ├── services/
│   │   └── riksdag/
│   │       ├── cache-wire.test.ts
│   │       ├── document-fixtures.ts
│   │       ├── documents.test.ts
│   │       ├── member-fixtures.ts
│   │       ├── members.test.ts
│   │       ├── normalize.test.ts
│   │       ├── pagination.test.ts
│   │       ├── speech-fixtures.ts
│   │       ├── speeches.test.ts
│   │       ├── text-output.test.ts
│   │       ├── transport-service.test.ts
│   │       ├── upstream-boundaries.test.ts
│   │       ├── vote-fixtures.ts
│   │       └── votes.test.ts
│   ├── smoke/
│   └── tools/
│       ├── documents.tool.test.ts
│       ├── list-reference.tool.test.ts
│       ├── members.tool.test.ts
│       ├── speeches.tool.test.ts
│       └── votes.tool.test.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._

/** @fileoverview Positive output ceilings retain strict numeric validation. @module tests/tools/output-ceilings */
import { describe, expect, it } from 'vitest';
import { riksdagGetDocument } from '@/mcp-server/tools/definitions/get-document.tool.js';
import { riksdagGetMember } from '@/mcp-server/tools/definitions/get-member.tool.js';
import { riksdagGetVotes } from '@/mcp-server/tools/definitions/get-votes.tool.js';
import { listReference } from '@/mcp-server/tools/definitions/list-reference.tool.js';
import { riksdagSearchDocuments } from '@/mcp-server/tools/definitions/search-documents.tool.js';
import { riksdagSearchMembers } from '@/mcp-server/tools/definitions/search-members.tool.js';

describe('output ceilings', () => {
  const cases = [
    [listReference.input, { topic: 'parties' }, 'limit'],
    [riksdagSearchDocuments.input, {}, 'pageSize'],
    [riksdagGetDocument.input, { documentId: 'HC01KU1' }, 'sectionLimit'],
    [riksdagSearchMembers.input, {}, 'limit'],
    [riksdagGetMember.input, { memberId: '0001' }, 'assignmentLimit'],
    [riksdagGetVotes.input, { mode: 'member', session: '2024/25', memberId: '0001' }, 'limit'],
    [riksdagGetVotes.input, { mode: 'report', session: '2024/25', report: 'KU1' }, 'pointLimit'],
  ] as const;
  it.each(cases)('accepts large positive ceilings for %j', (schema, base, field) => {
    expect(schema.safeParse({ ...base, [field]: 100000 }).success).toBe(true);
  });
  it.each(cases)('retains invalid numeric rejection for %j', (schema, base, field) => {
    for (const value of [0, -1, 1.5, 'many', null])
      expect(schema.safeParse({ ...base, [field]: value }).success).toBe(false);
  });
});

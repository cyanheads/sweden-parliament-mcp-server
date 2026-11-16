---
name: sweden-parliament-guide
description: Identifier chains and gates for the riksdag_* tools over Swedish Riksdag open data. Covers motion or bill to committee report, point and votes; report or interpellation to its debate; member to votes and speeches; SFS law to its amendment trail; committee participants. Use when a Riksdag question takes more than one riksdag_* call, or before reporting how a party or member voted, what was said in a debate, or what an SFS law says now.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

Riksdagen's open data, keyless: parliamentary documents (motions, government bills, committee reports, interpellations, chamber protocols), consolidated SFS statutes, chamber speeches, main votes and the member register. Not here: court rulings, amending acts as standalone texts, earlier versions of a statute, a committee-roster query, or a full-text search of what speakers said.

## Identifiers

| Identifier | Example | Comes from | Goes to |
|:--|:--|:--|:--|
| Document ID | `HC01UU6` report, `HC02192` motion, `HC0388` bill, `HC10116` interpellation, `HC0938` protocol | riksdag_search_documents rows; `references` rows of riksdag_get_document; main-vote rows; speech `protocolDocumentId` and `relatedDocumentId` | riksdag_get_document (any type); riksdag_get_votes report mode (committee reports only); riksdag_search_speeches `relatedDocumentId` (reports and interpellations) |
| Report designation | `UU6`: committee code plus number, read with its session | a report's `designation`; `references` rows; main-vote rows (a point-zero row carries a vote designation such as `0118-1`, which is not a report) | riksdag_get_votes `report`, the only report key member mode accepts |
| Point | `5` | the report's `decisions` | riksdag_get_votes `point` |
| SFS number | `2018:218` | the user (the `Lag (2025:256).` markers in statute text name amending acts, which are not documents here) | riksdag_get_document directly, no search needed |
| Member IID | `0473783431010` | riksdag_search_members; `memberId` on speech rows, main-vote rows and document `stakeholders` | riksdag_get_member; the member filters of the speech, vote and document tools |
| Speech ID | `HC0938-114`: protocol document ID plus speech number | riksdag_search_speeches rows | riksdag_search_speeches get mode |
| `voteId`, `sourceSpeechId`, `sourceRecordId` | UUIDs | rows | no tool; provenance only |

## Gates

- **Take the session from the record.** A riksmöte opens in September and runs into the next summer: a debate on 2024-09-25 and an interpellation dated 2025-05-09 both belong to 2024/25. Use the `session` on the report, on its `behandlas_i` reference row or on the vote row. An SFS statute's `session` is a calendar year, not a riksmöte.
- **Votes hang on committee reports.** A motion or government bill has none of its own. Its `references` in riksdag_get_document carry a `behandlas_i` row with the report's document ID, designation and session, and the report's `behandlar` rows list the motions it treated. Each point's `proposal` names the motions it decides by session and number ("2024/25:586 av Morgan Johansson m.fl. (S) yrkande 2"), matching the motion's `session` and `designation`. That is how a motion maps to a point.
- **Read Ja and Nej against the pairing.** Each decision summary's caption says what was put against what, such as "Utskottets förslag mot reservation 8 (S)". Ja backs the committee's proposal and Nej backs the reservation, so on a point that rejects motions a Nej is a vote for the reservation, not against those motions. `winner: utskottet` means the committee's proposal carried. Party code `-` groups members without a party.
- **One point, two votes.** A point can carry a vote on the substance (`avser: sakfrågan`) and a vote on the reasoning (`motivfrågan`). Each has its own party rows and its own row per member. Report them separately and never sum them. `Frånvarande` is a recorded absence.
- **Speech bodies are not searchable.** To learn what was said about a topic, find the report or interpellation with riksdag_search_documents, then read its debate.
- **A resumed debate loses its link.** When a debate is interrupted and resumed later, only the speeches before the break link the report. The resumed ones (heading "(forts. från § 11) Nationell säkerhetsstrategi (forts. UU6)") carry no `relatedDocumentId`, so relatedSpeechesCall finds 2 of the 25 speeches in the 2024/25:UU6 debate. Before calling a report debate complete, search the same session with `headingContains` set to the report title. The report's `protokolldebatt` reference names the protocol to read whole.
- **Narrow speech searches upstream.** Member and party filters shrink the request itself: one member's 2024/25 speeches are 58 candidates in about 1 s, against 14,207 in about 23 s for the whole session. `relatedDocumentId` and `headingContains` filter that downloaded list locally, and a repeat with the same session and narrowing within about two minutes reuses it. An interpellation's `stakeholders` give member IDs for the asker (`undertecknare`) and the answering minister (`besvaradav`). Narrowing to one speaker drops the other side of the exchange.
- **Use the all register only for discovery.** A cold name search there took 47 s of the tool's 55 s deadline. riksdag_get_member reads any numeric IID, whichever register or tool it came from, and speakers, voters and document signatories already carry theirs.
- **There is no roster query.** For who took part in committee Z's decisions in a session, search its reports (document type `bet`, the committee code, the session). A report's text, near the start after the committee's proposal, carries a line "Följande ledamöter har deltagit i beslutet: …" that lists names with party but no IDs. riksdag_get_member gives the member's side, one call per member: an assignment's `organ` is the committee code and its `role` is Ledamot, Suppleant, Ordförande and so on.
- **Answer SFS change questions from the amendment trail.** The consolidated text ends each amended provision with its amending act ("Lag (2025:256).") and labels the consolidation ("t.o.m. SFS 2026:1589"). A provision in transition appears twice, flagged "/Upphör att gälla U:2027-01-01/" and "/Träder i kraft I:2027-01-01/", and those dates say which text applies when. Amending acts are not documents here (2025:256 and 2021:1174 are not found), and there is no earlier version to compare. For the reason behind a change, full-text search the base law's number (`2018:218`) among bills or reports in the sessions around the amending act's year, then follow the bill to its report, where the point's proposal reads "lag om ändring i lagen (2018:218)".

## Workflows

**Proposal to decision.** riksdag_search_documents (motion `mot` or bill `prop`) → riksdag_get_document `references` → the `behandlas_i` report → its `decisions`, to find the point whose proposal names the motion → riksdag_get_votes report mode with that report and point. The report's `activities` date each step. `Behandling` is the chamber's consideration and `Beslut` the decision, and they can fall on different days (2024/25:UU6 was debated 2024-11-27 and decided 2024-11-28). A `Behandling` date does not mean a debate took place: 2024/25:UbU18 has one but no `protokolldebatt` reference and no speeches.

**Member X on report Y.** riksdag_search_members → IID → riksdag_get_votes member mode with the session, the IID and the report designation (add the point to narrow further). The vote rows also carry the report's document ID. For what the member said, run riksdag_search_speeches with the session, the IID and the report title as `headingContains`. `relatedDocumentId` alone misses resumed debates.

**Read a debate.** Start from relatedSpeechesCall on riksdag_get_document and, for a report, check it against the heading search above. Rows come in protocol order (the number in `speechId`), and each body is read through its get-mode `nextTextCall`. For the whole sitting as one text, riksdag_get_document reads the protocol by its document ID. A protocol is long (409,358 code points for HC0938), so read it in text pages.

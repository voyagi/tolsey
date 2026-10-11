# Privacy accountability

This file records who is responsible for the data the Tolsey Worker processes, what it processes,
why and on what legal basis, where, for how long and how it is deleted, followed by the decisions
that rest on it. Storage and retention are described in full in `docs/adr/0002-storage.md`.

## Controller and the people concerned

**Controller.** Taranity, contact support@taranity.com.

**People concerned.** Visitors to the public demo and callers of its MCP endpoint. Tolsey has no
accounts, and no real kitchen's staff use it in v1: the initials on a line come from a closed roster
of invented initials.

## What the Worker processes

Every purpose rests on GDPR Article 6(1)(f), legitimate interests, named per row. No purpose asks for
consent, and nothing is processed to make a decision about a person: a verdict judges a temperature
against its rule. Weighed against a visitor's own interests, each use is light: there are no
accounts, the initials are invented, the words are rebuilt from recognised tokens, and everything a
visitor writes is deleted within 24 hours.

| What | Why | Legal basis | Where | How long | How it is deleted |
| --- | --- | --- | --- | --- | --- |
| IP addresses of visitors | Cloudflare needs them to route and protect each request | Article 6(1)(f): delivering and protecting each request | In transit through Cloudflare's network | The Worker never stores or logs them | Nothing to delete: the Worker writes no IP address to the database or its logs |
| Readings, refusals and prompts written in the public demo | To show a spoken reading becoming a record line | Article 6(1)(f): showing the product to a visitor who chose to try it | A scratch kitchen in the D1 database | Deleted whole within 24 hours | An hourly job deletes each scratch kitchen and all its lines once it is 22 hours 45 minutes old |
| Staff initials | To show who logged a reading | Article 6(1)(f), as for the line they belong to | Stored with the line they belong to | As long as that line | With the line; any initials outside the kitchen's closed roster are refused and never stored |
| The words said with a reading | To show what was heard | Article 6(1)(f), as for the line they belong to | Stored with the line they belong to | As long as that line | With the line |
| Screen and request ids | To answer a retried or follow-up call from the same screen | Article 6(1)(f): answering a retried call once, with the same line | Stored with the line they belong to | As long as that line | With the line |

**Initials.** The demo kitchen's roster is a closed set of invented initials held as data. A write
with any other initials is refused with a named error, so only the roster's invented initials reach
the record, whoever says them.

**Words.** The stored words are rebuilt from the tokens Tolsey recognises: a check point's name, a
verb, the number, and a closed list of state and hedge words. A refused line, which has no number of
its own, quotes at most two figures of up to three digits, enough for "38 or 39", so digits said in
groups, such as a phone or card number, are never stored whole. Anything else a visitor says or types
is dropped before storage, so free text in the words never persists.

**Ids.** Screen and request ids are held to opaque tokens of up to 64 letters, digits, dots,
underscores, colons and hyphens, so a sentence or markup sent in place of an id is refused and never
stored. That rule cannot tell a random id from a name or a phone number written in the same
characters, so a caller who puts one there has it stored as sent, with the line, and deleted with the
scratch kitchen within 24 hours. The tool's description asks the host for a random id such as a UUID.
A pending question's id is Tolsey's own, made when the question is asked: an answer stores it to
name the question it answers, and an id a caller sends that names no question of this kitchen is
only looked up, never stored.

**Location.** The D1 database is created under the EU jurisdiction (`docs/adr/0002-storage.md`,
"Location and jurisdiction"), which keeps the stored record in EU regions. The Worker itself runs on
Cloudflare's global network, so a request can be handled in a data centre outside the EU.

**Deletion.** Scratch kitchens are deleted by the hourly job and by a sweep that runs whenever a new
kitchen is made. While the hourly runs succeed, nothing a visitor wrote outlives 24 hours. A run that
fails leaves its kitchens to the next hourly run or the next new kitchen's sweep. The judged demo
kitchen is read-only, so no visitor writes land in it.

## Processor and transfer

**Processor.** Cloudflare, Inc. hosts the Worker, its static assets, the D1 database and the hourly
Cron Trigger. It is the only service the product sends anything to, and the product uses no
analytics. Cloudflare processes as a processor under its Customer DPA, version 6.4, effective
2026-04-03 (https://www.cloudflare.com/cloudflare-customer-dpa/, read 2026-10-10), which forms part
of the subscription agreement the account runs under, the Self-Serve and the Enterprise Subscription
Agreement alike.

**Transfer.** Cloudflare, Inc. is in the US. The DPA covers a transfer of EU personal data with the
EU Standard Contractual Clauses (clause 6.2(a)), and in clause 6.4 Cloudflare states that it
complies with the EU-U.S. Data Privacy Framework.

## Security

- The Worker refuses any request to its MCP and API routes whose Host or Origin header names a host
  outside its configured list (`src/server/worker.ts`).
- The judged demo kitchen refuses every write. Visitor writes land only in a scratch kitchen reached
  by a 128-bit random id (`src/server/kitchens.ts`).
- Logs carry an error's name and code only, never a request's content (`src/server/guards.ts`).
  Cloudflare's per-request logs, which would record each URL and its metadata, are switched off in
  `wrangler.jsonc`, and the deploy preflight refuses a config that turns them on or leaves them to
  the platform's default (`scripts/deploy-preflight.mjs`). The Worker's own lines are kept for 3 days
  on the free plan.
- Free text never persists (Words, above), and initials outside the roster are refused (Initials).
- D1 encrypts stored data at rest with AES-256-GCM (Cloudflare's D1 data security documentation,
  read 2026-10-10).

## If a breach happens

1. Assess what was exposed, whose data it was and the likely risk to those people.
2. Report it to the Autoriteit Persoonsgegevens within 72 hours of becoming aware of it (GDPR
   Article 33), unless it is unlikely to result in a risk to people's rights and freedoms. A later
   report says why it is late.
3. Tell the people affected without undue delay when the risk to them is high (Article 34). Tolsey has
   no accounts and asks for no contact details, so that means a notice on the site.
4. Log every breach, reported or not: what happened, its effects and what was done (Article 33(5)).

Contact for anything in this file: support@taranity.com.

## Determinations

| Determination | Verdict | Date | Evidence |
| --- | --- | --- | --- |
| Personal data of real people in v1 | N-A - a closed invented roster, stored words rebuilt from recognised tokens only, scratch kitchens deleted within 24 hours, captures hold roster data only; the one path left is a caller writing a name or number into a screen or request id, stored as sent and deleted with its kitchen within 24 hours (see Ids) | 2026-09-29 | docs/adr/0002-storage.md |
| DPIA required (Article 35) | N-A - no special categories, no profiling of people and no large-scale monitoring; invented roster and deletion within 24 hours | 2026-10-10 | this file, What the Worker processes |
| AI Act Article 50 | N-A - no AI system runs in the default configuration; see docs/ai-act.md | 2026-09-28 | docs/ai-act.md |
| Demo video narration, AI Act Article 50(4) | N-A - owner-accepted risk, decided 2026-09-25 | 2026-09-25 | owner decision of 2026-09-25 |

# Privacy accountability

This file records what the Tolsey Worker processes, why, where, for how long and how it is deleted,
followed by the decisions that rest on it. Storage and retention are described in full in
`docs/adr/0002-storage.md`.

## What the Worker processes

| What | Why | Where | How long | How it is deleted |
| --- | --- | --- | --- | --- |
| IP addresses of visitors | Cloudflare needs them to route and protect each request | In transit through Cloudflare's network | The Worker never stores or logs them | Nothing to delete: the Worker writes no IP address to the database or its logs |
| Readings, refusals and prompts written in the public demo | To show a spoken reading becoming a record line | A scratch kitchen in the D1 database | Deleted whole within 24 hours | An hourly job deletes each scratch kitchen and all its lines once it is 22 hours 45 minutes old |
| Staff initials | To show who logged a reading | Stored with the line they belong to | As long as that line | With the line; any initials outside the kitchen's closed roster are refused and never stored |
| The words said with a reading | To show what was heard | Stored with the line they belong to | As long as that line | With the line |
| Screen and request ids | To answer a retried or follow-up call from the same screen | Stored with the line they belong to | As long as that line | With the line |

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
The id of a pending question a call answers is only looked up, never stored.

**Location.** The D1 database is created under the EU jurisdiction (`docs/adr/0002-storage.md`,
"Location and jurisdiction"), which keeps the stored record in EU regions.

**Deletion.** Scratch kitchens are deleted by the hourly job and by a sweep that runs whenever a new
kitchen is made. While the hourly runs succeed, nothing a visitor wrote outlives 24 hours. A run that
fails leaves its kitchens to the next hourly run or the next new kitchen's sweep. The judged demo
kitchen is read-only, so no visitor writes land in it.

**Third parties.** The product uses no analytics and sends nothing to any service other than
Cloudflare, which hosts the Worker and the database.

## Determinations

| Determination | Verdict | Date | Evidence |
| --- | --- | --- | --- |
| Personal data of real people in v1 | N-A - a closed invented roster, stored words rebuilt from recognised tokens only, scratch kitchens deleted within 24 hours, captures hold roster data only; the one path left is a caller writing a name or number into a screen or request id, stored as sent and deleted with its kitchen within 24 hours (see Ids) | 2026-09-29 | docs/adr/0002-storage.md |
| AI Act Article 50 | N-A - no AI system runs in the default configuration; see docs/ai-act.md | 2026-09-28 | docs/ai-act.md |
| Demo video narration, AI Act Article 50(4) | N-A - owner-accepted risk, decided 2026-09-25 | 2026-09-25 | owner decision of 2026-09-25 |

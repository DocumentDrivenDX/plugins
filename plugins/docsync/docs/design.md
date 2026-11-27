# docsync design

This document covers Claude Docs. [Word files](word.md) are the other target,
with their own design and testing record.

docsync keeps a Markdown file in a git repository and a Claude Doc in step, so
that people and an agent can edit and comment in the doc while the repository
holds the file. It is a TypeScript port of
[draftsync](https://github.com/DocumentDrivenDX/helix/tree/v0.25.0/tools/draftsync)
0.25.0 (HELIX ADR-019 and ADR-020), made neutral between projects and extended
for scholarly manuscripts.

## Split of work

The command works offline on files: it parses, patches, merges and refuses. Only
the agent calls Claude Docs: it creates the doc, reads it and sends edits. The
command never uses the network.

## What is kept from draftsync

- A file is a list of blocks: heading, paragraph, list item, table row, and
  `other`. `other` blocks are never patched.
- Edits are operations on block indexes. A replaced block changes only the words
  that differ; every other byte stays.
- When the file moved since the base, a three-way merge works on words. A
  conflict is words both sides changed differently. It stops the apply unless a
  winner is named, and each loss is listed.
- Draft changes come from two reads: the doc at the synced revision and the
  changes since. Anything with no certain Markdown form is refused by name.
- Writing back to the doc replaces only changed words, guarded by revision.
  Anything not certain is listed for a person.
- Front matter is never sent to the doc or patched. CRLF files are refused.

## What differs

| Subject | draftsync | docsync |
|---|---|---|
| Language | Python with PyYAML | TypeScript on a pinned Bun, no packages |
| Binding file | `.helix-bindings.yml` | `.docsync.json` |
| Git attribute | `<tool>-bind` | `docsync` |
| Which side wins a conflict | `ddx.authoring.home` in front matter | `record` in the binding: `git` (default) or `doc` |
| Generated-content guard | HELIX assessment tables | `apply --guard <program>`: any check; never stored in the repository |
| Making the doc | agent copies the body | `prepare` prints the Markdown to create it from |
| Block quotes | `other`, never edited | each quoted paragraph is a `quote` block |
| Characters escaped in doc text | every `*`, `_`, backtick, `<`, `\` | only where Markdown would read them, and never inside markers |
| Markers when writing back | any `[` or `]` leaves the change to a person | markers are plain text |
| Comments in a read | refused | ignored |
| Unaccepted suggestions | refused | left out and counted |
| A block added in the doc and already landed in git | inserted into the doc again | recognized and not inserted, and later new blocks go after it; one that git then reworded, or a quote only partly in the doc, is left to a person |
| Edit hook | `hook` command | not ported |

**Markers** are footnote references `[^label]`, citation brackets holding
`@key`, and attribute lists `{.class …}`, `{#id}` or `{name="value"}`. Nothing
inside one is escaped or read as formatting. They are how Pandoc-style and
Stemma manuscripts mark citations and spans.

**Block quotes.** A quote whose lines all start with `>` and that holds only
paragraphs becomes one `quote` block for each paragraph. A quote holding a list,
heading, table, code or nested quote, or continuing on a line without `>`, stays
`other`. An attribute line `{…}` directly under a quote belongs to the file: it
is not sent to the doc, and it stays under the quote. Deleting every paragraph
of a quote takes its attribute line too.

**Footnotes.** Claude Docs has no footnotes and refuses their syntax. `prepare`
escapes `[^label]` as `\[\^label\]`, so a footnote is plain text in the doc:
reviewers see the marker in the sentence and the note as a paragraph starting
`[^label]:`. In the file each definition line starts its own block.

## Commands

`prepare`, `blocks`, `edits`, `apply`, `doc-ops`, `bind`, `status`, `rebind`,
and `version`. Exit codes: 0 done; 1 refused or conflicted, nothing written;
2 usage or input error.

## Observed in Claude Docs

Observed on 2026-11-26 with one invented chapter, through the docs tools:

- Citation brackets, attribute lists and heading IDs stay as typed.
- Footnote syntax is refused at creation. `\[\^label\]` is accepted and reads
  back as `[^label]`.
- An attribute line directly under a quote is joined into the quoted paragraph.
- A hard-wrapped footnote paragraph is joined into one line.
- Edited quote paragraphs come back inside their `blockquote`.
- A comment appears as an empty `<comment id>` element inside the text.
- A suggestion appears as `<ins>` and `<del>`, with `<pending-suggestions>` and
  `<suggestions>` elements; the doc's current text keeps `del` and omits `ins`.

A full round trip then ran on 2026-11-26 through the commands: a doc made from
`prepare` output was bound; edits to cited sentences, two quoted paragraphs, a
footnote, a table cell and a new paragraph landed in the file with only those
words changed; changes committed in git were written back with `doc-ops`,
including one conflict resolved for git; a comment stayed in place; and `rebind`
confirmed that the doc then equalled the file. Those reads are the test
fixtures. The doc edits in it were made through the docs tools.

`tests/draftsync.test.ts` ports draftsync's tests as of HELIX commit 431c886,
under their own names: 92 of 97. The other five test the edit hook and HELIX's
own table script, and the file says why for each. It replays HELIX's recorded
reads, among them edits made in the Docs interface by three editors and the
reads around a live write-back. Where an expectation differs by design, the test
says so.

The merge and word patcher gave the same results as draftsync 0.25.0 on 4,379
randomized three-way merges, 995 of them with conflicts. That comparison needs
Python and is not part of the repository's tests.

Not tested: typing a manuscript in the Docs interface, including whether it
changes straight quotation marks inside markers; Codex; Windows. HELIX's
interface recording holds no manuscript markers.

## Limits

- docsync moves text. It does not check citations, quotations or anything else
  about what the text says.
- A doc is a hosted copy of the whole body. Anyone it is shared with can read it.
- The agent must read the report of every write-back: a conflict resolved
  toward the record discards the other side's words.

# Design: Word files as a sync target

**Status**: built in docsync 0.2.0. "What has been tested" says what has run and
what has not. Statements about how Word, other editors, or sync services behave
are assumptions unless that section reports them.

docsync keeps a Markdown file in a git repository and a `.docx` file in step.
The `.docx` usually sits in a folder that OneDrive, Dropbox, or iCloud Drive
syncs, where other people edit it. [The design](design.md) for Claude Docs still
holds: the command works on files, never uses the network, moves only the words
that changed, and refuses what it cannot carry with certainty.

## Goals

- Changes made in the Word file land in the Markdown file as a small diff.
- Changes committed to the Markdown file go into the current Word file without
  rebuilding it.
- Everything in the Word file that docsync does not edit survives: styles,
  comments, images, headers, fields, and parts it does not understand.
- No cloud API, sign-in, or runtime package is needed.

Not in the first version: a background watcher, automatic commits, merging two
Word files, other formats (`.doc`, `.odt`, `.pages`), and binding one Markdown
file to both a Claude Doc and a Word file.

## Why not convert in both directions

Markdown holds a small part of what a Word file holds. Writing a new `.docx` from
Markdown on each sync would discard the rest, including comments. So the codec has
an asymmetric shape:

- **Read**: `.docx` to a list of blocks with Markdown text, plus for each
  character its place in the file's XML.
- **Patch**: change those places in the existing XML, and copy everything else.

Creating a first `.docx` from Markdown is a separate, later command.

## Split of work

| Part | Source |
|---|---|
| Markdown blocks and patching (`parse`, `applyOps`) | `markdown.ts`, unchanged |
| Three-way word merge (`merge3`) | `merge.ts`, unchanged |
| Aligning lists | `align.ts`, used by Claude Docs; `docx/units.ts` has the stricter matching for Word |
| Marker spans and escaping | `markers.ts`, unchanged |
| ZIP read and write | `docx/zip.ts` |
| XML reader that keeps offsets | `docx/xml.ts`; `xml.ts` keeps none |
| Markdown to characters and back | `docx/inline.ts` |
| `.docx` to blocks | `docx/read.ts` |
| Blocks lined up, and changes carried into Markdown | `docx/units.ts` |
| Changes to XML patches | `docx/patch.ts` |
| Pull and push | `docx/sync.ts` |
| First `.docx`, and import | `docx/create.ts` |
| Synced-folder checks and safe replace | `docx/files.ts` |
| Snapshot and local path | `docx/state.ts` |
| Commands | `docx/cli.ts` |

The ZIP writer copies each unchanged entry's compressed bytes as they are and
compresses only the parts it patched. The XML is never parsed and written out
again as a whole: a patch replaces byte ranges, so unknown elements and
namespaces survive.

## State

A sync needs the last point at which the two sides said the same thing.

### In the repository

`.docsync.json` keeps its version 1 shape, so installed copies still read it:

| Field | Value for a Word target |
|---|---|
| `path` | the Markdown file |
| `tool` | `word` |
| `origin` | `word:<name>`, a short name chosen at `bind` |
| `syncedRev` | digest of the base snapshot |
| `baseSha256` | digest of the Markdown base body held in the snapshot |
| `record` | `git` or `doc`; here `doc` means the Word file |

The base is a **snapshot**, `.docsync/word/<name>.json`. It holds a Markdown body,
Word's ID for each footnote label, and the digest of the `.docx` bytes. The
body's blocks are the base of **both** sides: the Word base is not stored apart
from it, so the two cannot drift. It is committed with the binding and holds no
comments or author names. **No `.docx` is committed.** A pull compares the base
with a fresh read; a push patches the current file. Neither needs the old bytes.

The Markdown base is stored, not looked up in git history as `findBase` does for
a doc, because after a pull it may match no committed version of the file: it
holds the Word changes without the repository's own pending ones.

**The base moves block by block.** After `pull --write` or `push --write`, every
change that was carried is in the new base. One that was refused or left to a
person is not, so it is found and reported again. Without this, editing pulled
words in git would later look like a conflict.

This makes the snapshot and the Markdown file one unit. If someone discards a
pulled change to the file but keeps the new snapshot, the next push would read
that as a repository edit and undo the words in Word. So `pull` says to commit or
discard the two together, `push` requires both to be committed, and its preview
lists every change it would make.

The snapshot depends on how the reader reads. It records the reader's version;
a reader that reads differently needs a migration or a new bind.

The repository may hold symbolic links, so docsync writes none of its state
through one.

### On each machine

The path to the `.docx` differs between machines and can name a person, so it is
never committed. It is stored in the clone's git configuration as
`docsync.<name>.path`. A repository therefore cannot make docsync read or write a
file that the person at this machine did not name.

## Commands

`pull` and `push` print what they would do. Only `--write` writes. A conflict goes
to `--prefer`, or else to the binding's `record`, and is listed.

| Command | Does |
|---|---|
| `import DOCX` | Prints Markdown read from a `.docx`, for a project that has no Markdown file yet; notes about what has no Markdown form go to standard error |
| `create FILE --word OUT` | Writes a first `.docx` from a Markdown file; never overwrites |
| `bind FILE --word DOCX [--name NAME] [--record git\|doc]` | Binds a committed file to a `.docx` whose readable text matches it block for block; otherwise lists the differences and refuses |
| `locate FILE --word DOCX` | Sets this machine's path for an existing binding, after checking the file against the snapshot |
| `status FILE` | Says which sides changed since the base, and reports lock files, conflict copies, and pending tracked changes |
| `pull FILE [--prefer git\|doc] [--guard PROGRAM] [--write] [--accept-loss]` | Lands Word changes in the Markdown file |
| `push FILE [--prefer git\|doc] [--write] [--accept-loss]` | Puts committed Markdown changes into the Word file |

Unlike the Claude Docs flow, the command can read the shared copy itself, so one
command does each direction. The existing commands do not change.

## Reading a `.docx`

| Word | Markdown block |
|---|---|
| Paragraph with a heading style | heading |
| Paragraph with a quote style | quote paragraph |
| Paragraph with list numbering | list item |
| Table row | table row |
| Footnote | `[^label]` in the text and a definition block; the snapshot maps Word's ID to the label |
| Italic and bold runs | `*…*` and `**…**` |
| Other paragraph | paragraph |

Content with no certain Markdown form stays in the Word file and is reported. A
paragraph or footnote with an equation, a symbol character, an endnote reference,
hidden text, or an element the reader does not know that holds text, a table with
several paragraphs or none in a cell or a nested table, and a generated table of
contents are left out of the block list. Their words are remembered for the one
sync: a base block whose words are mostly there is **not** taken to be removed. A
picture or text box stays where it is, and the text around it is synced. Headers
and footers are not read. HTML comments in the Markdown never go to Word, and
code and HTML blocks are not synced.

Word splits a sentence into runs for reasons a reader cannot see, so adjacent
runs with the same Markdown formatting are read as one.

Saving in Word can change a file's bytes without changing its text. `status`
compares what the reader reads, not only digests.

## Which block is which

Both directions turn on knowing which block is which, so a block is taken to be
another only when their words say so:

1. Equal blocks that keep their order pair first.
2. Then equal blocks wherever they went, then blocks with close words. A pair that
   would have had to move needs much closer words.
3. When one block alone stands where one other stood, the two may be a rewrite.
   This is used to describe changes, **never** to decide which block gets
   overwritten.

A moved block is reported and left where it is on the other side; its words still
sync. A conflict is settled for one side only when Word's block still has most of
the base's words. A paragraph replaced by another is left for a person, so that
settling it cannot rewrite someone's new text.

## Changes that depend on each other

Splitting, joining, and moving text each take words out of one place and put them
in another. Carrying half would lose the words or double them.

- What is removed and added in one place is carried together or not at all.
- A change that takes out words a refused change was to put in elsewhere, or puts
  in words a refused change was to take out, is held back too.
- Words can be rewritten beyond recognition. So while any new text is refused, no
  block is removed and no change takes more than a word out of a block. This
  holds back changes that were unrelated; make the refused one by hand and sync
  again.
- A footnote changed on both sides is never merged: a mixed citation could name a
  page neither side meant. A footnote keeps its identity through a change of its
  words only if the same paragraph still cites it.
- A definition the file still refers to is not removed.
- A change that puts back words the other side removed, as when one side joins
  two paragraphs and the other deletes one, is reported.

## Pull

1. Run the file checks under "Synced folders".
2. Read the `.docx`.
3. Find the changes from the base to Word, as above.
4. Carry them into the Markdown base. This gives the new base.
5. Carry the same changes into the current file, block by block, so that what
   each side added at one place is kept on both. A change the file cannot take is
   left out of the new base too.
6. Read every changed block back from the resulting Markdown. If it would read as
   anything but what was meant, such as another kind of block, or broken
   emphasis, the change is refused. A block holding raw HTML, a bracketed
   address, an HTML comment, or a hard line break is not rewritten.
7. Run the guard and show the diff. With `--write`, write the file and the base.

Refused or left to a person: moves, new tables and lists, changed block kinds,
and changes to content that was not read. A new footnote made in Word lands with
a new label. A repeated pull with no new Word changes changes nothing.

## Push

1. Require the file and the snapshot to match the committed ones.
2. Run the file checks. Refuse if the file looks open.
3. Read the current `.docx` and merge, for each block, the base, the file, and
   the Word text. `--prefer` or the binding's `record` settles a conflict, and
   each loss is listed.
4. Patch only the changed words. New words go only into a run formatted as they
   are. A paragraph holding a comment, a bookmark end, a footnote reference, an
   editing permission, a section break, a field, or a picture is never deleted,
   nor is one that was edited in Word, whichever side wins, one whose removal
   would join two tables, or one that is all a content control holds.
5. Read the patched bytes back. The changed blocks must read as intended and all
   others as before, with tables grouped as before, or nothing is written.
6. Replace the file.
7. Move the base for what was carried, and say what still differs. The updated
   snapshot is left to be committed.

Push is narrower than pull. Moves, formatting, links, heading levels, block
kinds, new tables, and new footnotes are listed for a person.

## Tracked changes and comments

Pending tracked changes are treated as docsync treats open suggestions in a
Claude Doc: the current text keeps pending deletions and omits pending
insertions, and the report counts them. Nobody's suggestion is accepted for them.
Push leaves any block with a pending change to a person. A co-author who tracks
every edit must have changes accepted in Word before they land; `status` says so.

Comments are not part of the text. They stay in the Word file. Pulling them into
a report is a later feature.

## Markers and citations

docsync stays neutral between projects: it does not know what a citation looks
like when formatted.

**Markers are visible text**, as in a Claude Doc. `[@key …]`, `{.quote …}`, and
the rest appear in Word as typed. Footnotes are real Word footnotes, so a
citation in a note reads in its natural place.

- Pull compares the markers before and after, and lists every marker removed,
  changed, added, or moved to another block, and any bracket that no longer
  reads as a marker. It still shows the diff, and the person decides.
- Word may turn straight quotation marks into curly ones. Inside a marker's
  attributes, the reader changes them back.

**Possible later**: wrap each marker in a Word content control to make accidental
edits harder, and show formatted citations supplied by a program the project
names. No sync may depend on a content control surviving. Public bug reports show
that LibreOffice has
[dropped content controls](https://www.libreoffice.org/bugzilla/show_bug.cgi?id=137466)
in some versions.

## A copy that lost its structure

Some editors save a `.docx` as styled text, without heading or quote styles,
lists, tables, or footnotes. A pull from such a copy would strip the Markdown
file. docsync reports it when every footnote is gone, when more than half of four
or more footnotes are gone, when every table is gone, or when at least three and
at least half of the headings, quotes, and list items became plain paragraphs.
`pull --write` and `push --write` then refuse unless `--accept-loss` is given.
The thresholds are a judgement; smaller losses are listed but not refused, so the
preview must still be read.

## Limits of the reader

- Nearly identical blocks can be taken for one another. Read the preview.
- Underline, color, size, and other formatting beyond italic and bold are not
  carried. They stay in the Word file.
- Where Markdown cannot express an overlap of bold and italic inside a word, the
  paragraph is read as plain text, with a note, and push leaves it alone.
- A footnote of several paragraphs is not edited. Endnotes are not synced.
- A paragraph that holds a field, such as a cross-reference or a reference
  manager's citation, lands when pulled, with the field's shown text; push leaves
  the whole paragraph to a person.
- Push does not add footnotes, links, lists, or tables, and does not change
  formatting, heading levels, or block kinds.
- Pull does not carry moved blocks, new lists, new tables, or changed block kinds.

## Synced folders

docsync reads and writes an ordinary local path. The sync service moves the file.

| Hazard | Behavior |
|---|---|
| File is online-only | Reading may start a download. A file with a size and no disk blocks is noted as online-only. If the read fails, say that the file must be downloaded. There is no time limit on a read that does not finish |
| An iCloud placeholder (`.<name>.icloud`) stands in for the file | Say so; write nothing |
| File is partly written | Check every entry's size and CRC, and read the bytes twice; refuse if they differ or fail |
| File is open on this machine | Refuse to push when an owner file is present: Word's `~$…` or LibreOffice's `.~lock.…#` |
| File is being edited elsewhere or in a browser | Cannot be detected from the folder. Say so |
| File changes during a push | Compare the digest again just before replacing; refuse if it moved |
| Sync service made a conflict copy | List sibling files that look like one. Never merge, rename, or delete them |

Conflict-copy names differ by service, and the descriptions found so far come
from secondary sources, so docsync reports any near-match
sibling `.docx` instead of relying on exact patterns.

Before replacing a file, push copies it into `.git/docsync-backups/` and prints
that path. These copies are never removed by docsync. It then writes the new file
beside the old one, as `.docsync-<random>.tmp`, and renames it over the old one,
so a reader never sees half a file. A sync service might treat the renamed file
as new and lose its share link or version history. That is **untested** for every
service; check it once on a file that matters little.

A small race remains between the last check and the rename, and edits made on
another machine may not have arrived yet. docsync cannot lock a cloud file. It
relies on the backup, the service's version history, and conflict copies.

## Safety

- A `.docx` from another person is untrusted. Entry names are never used as disk
  paths; entry count and expanded size are capped; document type declarations are
  refused; external relationships are never followed; macros are never run.
  `.docm` is refused.
- Text from the Word file is data. It cannot name a program, a path, or a setting.
- A push puts text where everyone with access to the folder can read it. The
  skill says so before the first push.
- The skill never commits, accepts a tracked change, or deletes a conflict copy
  unless asked.

## What has been tested

Run on one Mac on 2026-11-26.

| What | Result |
|---|---|
| Automated tests | Invented `.docx` files: round trips, refusals, base movement, hostile archives, and randomized edits on both sides |
| Independent review before release | Two rounds found ways earlier drafts lost, damaged, or mixed up text. Their cases are tests in `tests/word/regressions.test.ts`. The fixes after the second round were checked by those tests and the randomized runs, not by a third review |
| Randomized two-sided edits | Tens of thousands of generated single rounds of edits on both sides, and 1,500 sequences of 14 steps for each setting of `record` with footnotes, formatting, comments, tracked changes, tables, splits, and joins, ended with no block or word lost without a report. A further 1,500 that also make near-copies of paragraphs left a few flags: most are the copies' shared words, and one is a copy taken for the paragraph it was made from, named in the report. The generators use invented sentences. A small run is part of the tests |
| XML and ZIP validity | A created file passes `unzip -t`, and its parts pass `xmllint` |
| pandoc 3.14 reads a created and a patched file | Text, footnotes, lists, table, and link read back |
| pandoc 3.14 writes the Word file | `import`, `bind`, and a push of changes to a quote, a list item, a table cell, a footnote, and a new paragraph; pandoc read the result as intended |
| Apple `textutil` (macOS) saves the file again | Styles, lists, the table, the link, and footnotes are lost. `bind` refuses it, and `pull --write` refuses it as a copy that lost its structure |
| macOS Quick Look | Renders a created file with its headings, lists, table, and link |
| iCloud Drive, one machine | A push replaced the file and left no other file in the folder. After the local copy was evicted, the file had no disk blocks, docsync noted it as online-only, and reading it downloaded it |

**Untested**: Microsoft Word on any system, including whether it opens these
files without a repair prompt and what it changes when it saves; Word for the
web; LibreOffice; Pages; Google Docs; TextEdit's interface; OneDrive; Dropbox;
iCloud sharing, share links, version history, and edits from two machines;
real conflict-copy names; Windows and Linux; and a real manuscript. The fixtures
are shaped after what these editors are understood to save, which is not evidence
of what they save.

To test an editor: `create` a file from an invented chapter, `bind` it, edit and
save it in the editor, then run `status` and `pull`. An unchanged save should
report no change. After a `push`, open the file there and check that it opens
without a repair prompt, with comments and footnotes in place.

## Later

Report comments, write pushed changes as tracked changes, protect markers with
content controls, show formatted citations, and watch a folder to say when a file
changed. None of these is built.

## Open questions

1. Does a rename keep share links and version history on each service?
2. Should push write tracked changes, so co-authors can review what came from the
   repository? It is safer for them, but until accepted those words read as
   absent, so the base must not move for them.
3. Should one Word file be able to hold several Markdown files, such as the
   chapters of a book? Each binding is one to one.
4. Are visible markers acceptable to co-authors? If not, formatted citations move
   ahead of other later work.

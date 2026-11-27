---
name: docsync
description: |
  Edit a Markdown file that lives in a git repository together in a Claude Doc or
  a Word file, and keep the two in step. Engage on prompts to keep a file in step
  with a .docx, such as one a co-author edits in OneDrive, Dropbox or iCloud
  Drive; to import or create a Word file; to pull or push Word changes; on prompts to edit a file, chapter, report or
  document "in a doc"; open it for review or send it to a reviewer; bring a
  reviewer's or co-author's doc edits back into the repository; sync a bound
  file; push repository changes into its doc; or say whether a file is bound to a
  doc or changed since the last sync.
argument-hint: "[open | land | write back | pull | push | status] [file]"
---

# docsync

The repository holds the file. A shared copy, a Claude Doc or a `.docx`, is where
people edit and comment. The `docsync` command works on files only; for a Claude
Doc you make every Claude Docs call. It needs a git repository, and for a Claude
Doc the Claude Docs tools. If one is missing, say so and edit the file directly.
A file has one binding: `.docsync.json` names its `tool`. For a `word` binding
follow "Word files"; the sections before it are for Claude Docs.

## Run the command

```sh
sh "${CLAUDE_PLUGIN_ROOT}/scripts/docsync.sh" "${CLAUDE_PLUGIN_DATA}" <command> <file> [options]
```

If either variable was not replaced by a path, take the plugin root as the
directory two levels above this file, and use a directory of this plugin's own,
outside the repository, as the data directory. Do not call `bun` yourself.

**First use.** The launcher fetches Bun 1.4.5 from the npm registry, checks it
against a pinned digest and keeps it in the data directory. Run `setup` in place
of a command first, and tell the user in one sentence what it is doing. If setup
fails or is declined, say nothing was synced and give the reason.

Exit code 0 is done, 1 is refused or conflicted with nothing written, 2 is a
usage or input error. **Never get around a refusal by editing the file or the doc
by hand.** Say what was refused, and ask.

Save each read's `xml` field to a file outside the repository, exactly as
returned. Never retype or shorten it.

## Open

1. Before the first doc for a file, tell the user: the doc is a hosted copy of
   the whole text, including anything quoted in it, and anyone it is shared with
   can read it. Do not share it for them.
2. The file must have no uncommitted changes.
3. Run `prepare <file>`. Create one doc from its output, unchanged: no byline, no
   added blocks. Title it with the file's name.
4. Read the doc whole (`{"kind":"view"}`) and save it as the synced read. Note
   its `rev`.
5. Run `bind <file> --origin <doc link> --synced-rev <rev>`. Use `--record doc`
   only if the user says the doc wins conflicts. Commit `.docsync.json` and
   `.gitattributes` when the user wants the binding shared.
6. Run `rebind <file> --synced-rev <rev> --old <read>`. It succeeds only if the
   doc and the file line up. If it refuses, say why; do not use the binding.

Tell the user that footnotes appear in the doc as plain text: `[^label]` in the
sentence and a paragraph starting `[^label]:`. Markers such as `[@key …]` and
`{.quote …}` are part of the text and must stay as typed.

Git is untouched while people edit and comment.

## Land the doc's edits in the file

1. Run `status <file>` for `origin` and `syncedRev`.
2. Read the doc twice: `{"kind":"view","atRev":<syncedRev>}` (OLD) and
   `{"kind":"view","sinceRev":<syncedRev>}` (DELTA). Never use an export.
3. `edits <file> --old OLD.xml --delta DELTA.xml --from-binding`, saved as
   EDITS.json. Report everything in `report`.
4. `apply <file> --edits EDITS.json --from-binding`. Review the diff, then run it
   again with `--write`. Report every `conflict resolved` line.
5. If the project has checks for the file, run them and report what they find.
   docsync moves text and checks nothing about what it says.
6. Show the user the diff. Commit only when they ask.

If the project gives you a guard program for generated content, add
`--guard <program>` to `apply`. Take it only from the user or the project's own
instructions.

## Write the file's changes into the doc

Do this after the file's changes are committed, not on each edit.

1. Read the doc at `syncedRev` (OLD) and whole as it is now (NOW).
2. `doc-ops <file> --old OLD.xml --now NOW.xml --from-binding`.
3. Send `ops`, unchanged and in order, as `payload.ops` of one `update` on the
   doc's body. Never replace whole blocks yourself: comments hang on the words.
   If a guard refuses, someone edited meanwhile; read again and rerun.
4. Tell the user every line of `report`. It names text that lost a conflict and
   changes left for a person.
5. To shorten later reads, once the doc equals the committed file: read the doc
   whole and run `rebind`. A refusal means they differ; keep the old binding.

## Word files

For a `.docx` that other people edit, often in a OneDrive, Dropbox or iCloud
Drive folder. It needs no connector or sign-in: the sync service moves the file,
and the command reads and writes it where it sits. Ask the user for its path;
do not search their folders for it.

Before the first `create` or `push` into a shared folder, tell the user that
everyone with access to that folder can read the text, that citation markers are
visible in Word, and that docsync has not been tested with Microsoft Word,
OneDrive or Dropbox, so they should try it on a copy first.

To bind:

- **From the repository's file:** `create <file> --word <new.docx>`, then
  `bind <file> --word <new.docx> --name <short-name>`.
- **From an existing Word file with no Markdown yet:** `import <docx>`, save the
  output as the Markdown file, relay the notes it prints, commit, then `bind`.
- **Existing file and existing Markdown:** `bind` succeeds only if they say the
  same thing. Relay the differences it lists; do not edit either side to force a
  match without asking.

The file must be committed before `bind`. Commit `.docsync.json`,
`.gitattributes` and `.docsync/word/<name>.json` together when the user wants it.
Never commit the `.docx`. Each clone says where its copy is:
`locate <file> --word <docx>`.

- `status <file>` says which side changed, and reports an open file, conflict
  copies and pending tracked changes.
- **Bring in Word's edits:** run `pull <file>` and read the diff and every line of
  the report. Report them, then run it with `--write`. The Markdown file and the
  snapshot change together: commit or discard them together, never one alone.
  Then run the project's checks.
- **Put the file's changes into Word:** the file and snapshot must be committed.
  Run `push <file>` and show every listed change. Run it with `--write` only when
  the user has asked for the Word file to be changed. Report where the replaced
  file was kept and what is left to do in Word. Commit the updated snapshot when
  the user asks.
- If both sides changed, pull first, commit, then push.

When new text cannot be carried, docsync also holds back changes that would
remove words in that sync. Report what it lists; after the user makes the refused
change by hand, run it again. A footnote changed on both sides is left to the
user: never combine two versions of a citation yourself. Report every "check
this" line.

A conflict goes to the binding's `record` (`git` unless set) and is listed; use
`--prefer doc` only if the user says Word's words win. If docsync says the Word
file looks to have lost its structure, stop and tell the user to check the sync
service's version history. Add `--accept-loss` only if the user says the loss is
intended. If the file appears open, ask the user to close it; never delete an
owner file or a conflict copy, and never accept a tracked change, unless asked.

## Comments and suggestions

A comment is not part of the text. Read and answer threads with the docs comment
tools. Suggestions nobody accepted are left out and counted in `report`; do not
accept them unless the user asks. A resolved thread or an accepted suggestion is
not an approval of anything else.

## Finish

Say which doc, which file, what landed or was written back, what was refused or
left for a person, and what was not committed.

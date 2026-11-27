---
name: docsync
description: |
  Edit a Markdown file that lives in a git repository together in a Claude Doc,
  and keep the two in step. Engage on prompts to edit a file, chapter, report or
  document "in a doc"; open it for review or send it to a reviewer; bring a
  reviewer's or co-author's doc edits back into the repository; sync a bound
  file; push repository changes into its doc; or say whether a file is bound to a
  doc or changed since the last sync.
argument-hint: "[open | land | write back | status] [file]"
---

# docsync

The repository holds the file. A Claude Doc holds a copy that people and you edit
and comment on. You make every Claude Docs call; the `docsync` command works on
files only. It needs the Claude Docs tools and a git repository. If either is
missing, say so and edit the file directly.

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

## Comments and suggestions

A comment is not part of the text. Read and answer threads with the docs comment
tools. Suggestions nobody accepted are left out and counted in `report`; do not
accept them unless the user asks. A resolved thread or an accepted suggestion is
not an approval of anything else.

## Finish

Say which doc, which file, what landed or was written back, what was refused or
left for a person, and what was not committed.

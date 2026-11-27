# docsync

Edit a Markdown file from your repository in a Claude Doc, with other people,
and bring the changes back as a small diff. Only the words that changed move;
the rest of the file stays byte for byte as it was. Changes made in the
repository go back into the doc without replacing it, so comments stay attached.

docsync is a Claude plugin with one skill. Ask Claude to "open this chapter in a
doc", "bring in the doc's edits" or "put my changes into the doc". Claude runs
the commands.

It is a TypeScript port of
[draftsync](https://github.com/DocumentDrivenDX/helix/tree/v0.25.0/tools/draftsync)
from HELIX, and adds what scholarly manuscripts need: editable block quotes,
footnotes, and citation and span markers that stay intact.

## What you should know

- **The doc is a hosted copy** of the whole text. Anyone it is shared with can
  read it.
- **Footnotes are plain text in the doc.** Claude Docs has none, so you see
  `[^1]` in the sentence and the note as its own paragraph.
- **docsync refuses what it cannot carry with certainty**, such as a moved block
  or a new table made in the doc. It says what, and writes nothing.
- **Writing back is narrower than landing.** Some changes, such as new
  formatting, are listed for you to make in the doc.
- **It checks nothing about what the text says.**

See [the design](docs/design.md) for the rules and for what has and has not been
tested.

## Install

From the DocumentDrivenDX marketplace with Claude Code:

```sh
claude plugin marketplace add DocumentDrivenDX/plugins
```

```sh
claude plugin install docsync@documentdrivendx
```

Installing the plugin is the only installation there is. On first use it fetches
a pinned Bun into its own data directory and checks it against a digest shipped
in the plugin.

## Develop

```sh
sh scripts/dev.sh check
```

It fetches the pinned Bun into `.tools/`, then type checks and runs the tests.
The command line has no runtime dependencies. To try a checkout without
installing it, run `claude --plugin-dir /path/to/docsync`.

## Release

The marketplace, [DocumentDrivenDX/plugins](https://github.com/DocumentDrivenDX/plugins),
holds a built copy of the plugin under `plugins/docsync`. GitHub Actions
publishes it when a release tag is pushed.

1. Give `.claude-plugin/plugin.json` and `package.json` one new version.
   Installed copies update only when the version changes.
2. Run `sh scripts/dev.sh check` and `sh scripts/dev.sh plugin-check`, then
   commit and push. The workflow runs no tests.
3. Tag that commit `v<version>` and push the tag. Publishing a release on GitHub
   for a new tag does the same.

The [workflow](.github/workflows/publish.yml) creates the tag's GitHub release
if it has none, even if publishing then fails, so a release does not show that
the version reached the marketplace; the workflow run does. It replaces only
`plugins/docsync` and refuses a tag that does not match the version, changed
files under a published version, or a version older than the published one.

It pushes with a short-lived token of a GitHub App installed only on the
marketplace repository, with Contents read and write. This repository needs the
app's client ID in the variable `PLUGINS_APP_CLIENT_ID` and its private key in
the secret `PLUGINS_APP_PRIVATE_KEY`. Anyone who can push a release tag here, or
push to the marketplace, can change what installs.

MIT License.

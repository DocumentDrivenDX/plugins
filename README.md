# DocumentDrivenDX plugins

The Claude plugin marketplace for [DocumentDrivenDX](https://github.com/DocumentDrivenDX).

With Claude Code:

```sh
claude plugin marketplace add DocumentDrivenDX/plugins
claude plugin install stemma@documentdrivendx
claude plugin install docsync@documentdrivendx
```

| Plugin | What it does | Source |
|---|---|---|
| `stemma` | Create academically rigorous research reports and books, with citations checked against your own stored copies | [DocumentDrivenDX/stemma](https://github.com/DocumentDrivenDX/stemma) |
| `docsync` | Edit a Markdown file from your repository in a Claude Doc and sync the changes both ways | [DocumentDrivenDX/docsync](https://github.com/DocumentDrivenDX/docsync) |

Directories under `plugins/` are built from each plugin's source repository. Change
a plugin there, not here. Each plugin carries its own license.

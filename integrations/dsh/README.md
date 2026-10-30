# dsh-plugin-prismsearch

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle for [PrismSearch](https://github.com/xiaonerner0821/prismsearch): multi-engine web, image and WeChat search plus page/PDF fetching, with no search account or API key required.

Installing this bundle adds two rows to your DSH profile:

| Row | What it does |
|---|---|
| `prismsearch-plugin-mcp` | Starts the pinned `prismsearch` MCP server over stdio (`npx -y prismsearch@<version>`). Tools appear as `mcp__prismsearch__web_search`, `mcp__prismsearch__fetch_page`, … |
| `prismsearch-plugin-skill` | Serves the bundled `prismsearch` skill, which tells the agent which tool to use, how to read pages after searching, and how to cite sources. |

## Install

In the DSH Web GUI, open **Plugins**, choose to install a package, and enter:

```
dsh-plugin-prismsearch
```

Or ask the agent to install it with the `plugin_manager` tool. Restart DSH if your profile does not hot-reload.

Requirements: Node.js `>=22.19.0` on `PATH` (the server is launched with `npx`). The first start downloads `prismsearch` from npm, so it may take a few seconds.

## Optional API keys

No key is needed. If these environment variables are set where DSH starts, they are forwarded to the server for extra reliability:

- `BRAVE_API_KEY`
- `GOOGLE_API_KEY` and `GOOGLE_CSE_ID`

Set them in your shell or system environment. Never paste keys into a chat or into a patch file.

## Already configured PrismSearch by hand?

If your profile already has an MCP row with `serverName: prismsearch`, the two rows conflict and the one loaded later fails. Remove your manual row, or rename its `serverName` (for example to `prismsearch-dev`), before enabling this bundle.

## Versioning

The bundle version always equals the PrismSearch version it launches. Upgrade by removing and reinstalling the bundle at the new version.

## License

Apache-2.0. See [LICENSE](LICENSE). Scraping engines fetch public result pages; you are responsible for complying with each search engine's terms of service. See the [main README](https://github.com/xiaonerner0821/prismsearch#disclaimer).

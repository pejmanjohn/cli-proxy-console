# CLI Proxy Console fork

This fork adds the quota **Ledger** layout to the upstream CLI Proxy API Management Center. It uses the existing v8 Management API, provider adapters, authentication store, and confirmed reset operations. The API gateway and provider credentials remain managed by CLIProxyAPI.

The ledger is the initial quota layout. It has provider totals with a segment per credential, grouped account rows, remaining quota meters, reset countdowns, subscription renewal details, and manual reset availability and expiry. The existing Cards layout, search, sorting, and quota timeline are available in the layout selector. Email visibility and layout preferences last for the browser session. New users start in the dark theme; saved theme preferences are respected.

Totals sum the remaining percentage for the **same quota window** across matching credentials. Their capacity is 100% per credential; for example, 409% of 500% spans five accounts. An unloaded, failed, or unavailable observation leaves the total unknown, rather than treating that account as exhausted. Disabled credentials follow the upstream provider filters. Totals cover all matching pages; refresh concurrency and pagination follow upstream behavior.

Email masking conceals mailbox names in quota labels, tooltips, and action labels. It is a presentation preference, not an access-control boundary. The authenticated management API, other console pages, and existing notifications still have access to credential filenames.

## Develop and verify

```sh
bun install --frozen-lockfile
bun run dev
bun run verify
```

Use the Bun version in `package.json`. Keep the fork remote as `origin` and the original repository as `upstream`, and make future changes on topic branches. Review upstream changes and run the local verification before integrating them.

## Install a build

```sh
VERSION="ledger-$(git rev-parse --short HEAD)" bun run build
```

The resulting `dist/index.html` is a self-contained management panel. Back up the current panel and server configuration privately, then atomically replace the server's `static/management.html` with this file. Do not check credentials, server configuration, or live account snapshots into the repository.

Set the following in the CLIProxyAPI v8 configuration so the background updater cannot replace the customized panel:

```yaml
management:
  disable-auto-update-panel: true
  panel-github-repository: https://github.com/pejmanjohn/cli-proxy-console
```

Older configuration layouts use `remote-management` for this section. Merge these two properties into the existing section, keeping its authentication and access settings. CLIProxyAPI normally places the panel beside its configuration file in `static/management.html`; an existing `MANAGEMENT_STATIC_PATH` override takes precedence. Check the actual serving path before copying. Keep the panel file in place: even with periodic updates disabled, a missing file can trigger a first-access download.

Reload the management page, verify the serving artifact, sign-in, account refresh, and gateway model discovery. Panel upgrades are now deliberate builds from the fork; backend upgrades can continue independently.

To roll back, atomically restore the backed-up HTML and restore the two panel properties in the configuration. Do not restore an entire old configuration over unrelated changes made since the backup.

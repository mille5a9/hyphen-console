# Hyphen Console

A small self-hosted console for an indie developer with apps on the App Store and Google Play. It runs on a home server and is reachable only from the home network and a Tailscale tailnet.

**Today:** one download page per app for test builds (Android APKs with their Play bundles, and iOS IPAs), so a phone can install the latest build straight from the NAS.

**Next:** gather the things worth checking every week into one place, for every app: crash and ANR rates from both stores, new reviews, and whether each app's backend is up. Alerts arrive when something needs attention. See [Roadmap](#roadmap).

<img src="docs/builds-page.png" alt="An app's builds page: the newest Android build on top, iPhone builds, then every Android build with its Play bundle" width="360">

## Design

- **No runtime dependencies.** Node 24 runs the TypeScript directly (type stripping), and the server uses only `node:http` and `node:fs`. `typescript` and `@types/node` are dev-only, for type checking.
- **Configuration lives outside the repo.** Machine-specific settings go in `.env` and `config/apps.json`, and git ignores both. The committed `.env.example` and `config/apps.example.json` hold only placeholders. API keys for later phases will go in `secrets/`, which git also ignores.
- **Private by default.** The server refuses any client outside an allowlist of CIDRs: private LAN ranges, Docker's bridge, loopback and Tailscale. Override it with `ALLOWED_CIDRS`. It answers only `GET` and `HEAD`.
- **Serves build files only.** File URLs must name a build of that app (`<prefix>-<x.y.z>….apk|aab|ipa`, or its `.sha256`). Other files in the folder, paths and dot files are never served. Downloads support byte ranges, so a phone can resume a large APK.
- **Locked-down container.** No Linux capabilities, `no-new-privileges`, a read-only root filesystem and read-only mounts. It runs as the unprivileged `node` user unless `CONTAINER_USER` says otherwise.
- **Strict headers.** A same-origin Content Security Policy (the page's script and styles are separate files, not inline), plus `nosniff`, `no-referrer` and frame denial.
- **CI** type-checks, runs the tests, builds the image, and runs [gitleaks](https://github.com/gitleaks/gitleaks) over the full history.

## Setup

```bash
cp .env.example .env                           # set BUILDS_ROOT, PORT
cp config/apps.example.json config/apps.json   # list your apps
docker compose up -d --build
```

Builds go in `<BUILDS_ROOT>/<app id>/`, named `<filePrefix>-<version>[-<extra>][-<abi>].<apk|aab|ipa>`:

| File | Shown as |
|---|---|
| `my-app-1.2.0-arm64.apk` | release 1.2.0 |
| `my-app-1.2.0.aab` | the Play bundle, beside the 1.2.0 APK |
| `my-app-1.2.0-dev.a1b2c3d-arm64.apk` | dev build of 1.2.0, tagged `dev.a1b2c3d` |
| `my-app-1.2.0.ipa` | iOS release 1.2.0 |

Copy builds in under a temporary dot-file name and rename them when the copy finishes, so the page never lists a half-copied file. A `<file>.sha256` beside a build is linked from the API.

Open `http://<server>:<PORT>/` for the app list, or `/apps/<id>` for one app's builds.

### Settings

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8095` | Host port |
| `BIND_IP` | `0.0.0.0` | Host address to listen on |
| `BUILDS_ROOT` | — | Host folder with one subfolder per app (required) |
| `ALLOWED_CIDRS` | private ranges, loopback, Tailscale | Comma-separated client allowlist |
| `CONTAINER_USER` | `node` | Set `0` for NFS exports that refuse container uids (the container stays capability-free and read-only) |

## API

| Route | Returns |
|---|---|
| `GET /api/apps` | `[{ id, name }]` |
| `GET /api/apps/<id>/builds` | `{ app, android: Build[], ios: Build[] }`, newest first |
| `GET /files/<id>/<file>` | The build file, with range support |
| `GET /healthz` | `ok` |

## Development

```bash
npm install
npm run check                          # typecheck + tests
CONFIG_FILE=config/apps.json BUILDS_ROOT=/path/to/builds PORT=8096 npm run dev
```

## Roadmap

1. ~~Multi-app builds page~~
2. Health checks for each app's backend, with alerts
3. Reviews from both stores, kept over time (Google Play's API only returns the last week)
4. Crash and ANR rates (Play Developer Reporting API) and crashes, installs and sessions (App Store Connect Analytics Reports API)
5. A weekly digest

## License

[MIT](LICENSE)

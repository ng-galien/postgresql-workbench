# CI, release, and Marketplace publication

This document is the operational reference for validating and publishing the
`ng-galien.postgresql-workbench` VS Code extension.

There are three independent GitHub Actions workflows:

- [CI](.github/workflows/ci.yml) validates pull requests and can be run
  manually;
- [Extension Release](.github/workflows/release-extension.yml) rebuilds,
  releases, and publishes the extension for `extension-v<version>` tags;
- [DAP Release](.github/workflows/release-dap.yml) validates and publishes the
  standalone `@ng-galien/postgresql-dap` package for `dap-v<version>` tags.

The release workflow never publishes a developer-built VSIX. It builds and
validates one target-specific artifact for Linux x64, macOS ARM64, macOS x64,
and Windows x64 in GitHub Actions, attaches those artifacts to the GitHub
Release, attests their build provenance, and passes the same artifacts to the
Marketplace job.

## Continuous integration

### Triggers

CI runs automatically for pushes to `main` and pull requests targeting `main`.
It can also be started manually:

```bash
gh workflow run ci.yml --ref main
```

Wait for all jobs on the exact release-preparation commit to succeed before
creating a release tag.

### Jobs

All CI jobs are independent and normally run in parallel.

All external actions are pinned to full commit SHAs. The trailing version
comments are documentation only; update both the SHA and comment when upgrading
an action.

Dependabot checks GitHub Actions weekly. It opens pull requests that update the
pinned SHA and the same-line version comment. Review upstream release notes and
require the complete CI result before merging an action upgrade, especially for
release and artifact-handling actions.

| Job | Contract |
| --- | --- |
| `Biome` | Installs root dependencies and runs `npm run check`. |
| `Architecture` | Checks the package boundaries with the code-moniker architecture profile. Any non-zero status fails it, including a configuration error that would otherwise disarm the check without failing it. |
| `Type Check` | Type-checks the DAP server and the VS Code extension. |
| `Unit Tests` | Runs the root Vitest suite. |
| `DAP Integration` | Starts `galien0xffffff/postgres-debugger:17` and runs the real PostgreSQL DAP and Workbench integration suite. |
| `VS Code Technical` | Runs the extension-host integration suite in a real VS Code instance. |
| `Playwright` | Runs the end-user Workbench, notebook, and debugger journeys in VS Code and retains failure evidence. |
| `VS Code Compatibility` | Activates the extension and Code Moniker on the minimum supported VS Code 1.109.0. |
| `EnterpriseDB pldebugger Compatibility` | Builds and tests against the pinned unpatched EnterpriseDB pldebugger implementation. |
| `Smoke standalone DAP` | Packs, installs, and smoke-tests the standalone npm DAP on Linux, macOS ARM64/x64, and Windows x64. |
| `Package extension` | Builds, validates, and smoke-tests one target-specific VSIX for Linux x64, macOS ARM64/x64, and Windows x64. |

The extension runs on the Node its host ships, never on the Node this repository
builds with. VS Code 1.109.0, the minimum the manifest declares, runs extensions
on Node 22.21.1, and `engines.node` in `vscode-extension/package.json` states
exactly that. `npm run check` fails when the two disagree. Raising the minimum
VS Code therefore means measuring the Node of the new minimum and declaring it
in `scripts/extension/check-manifest-text.mjs`:

```bash
ELECTRON_RUN_AS_NODE=1 "$HOME/Applications/Visual Studio Code.app/Contents/MacOS/Electron" -e "console.log(process.versions.node)"
```

The integration job uploads VS Code logs even when tests fail. Download the
`vscode-test-logs` artifact from the failed workflow run before rerunning a
timing-sensitive or lifecycle-sensitive failure.

The CI VSIX artifacts prove that the extension packages correctly on every
supported host, but they are not release artifacts. The release workflow always
rebuilds from the tagged commit.

Both workflows install the published Code Moniker client and native packages
from npm using `vscode-extension/package-lock.json`. They never check out or
build Code Moniker source. Update the npm dependency and lockfile explicitly
when adopting a new Code Moniker release, then validate every packaged target.

The standalone DAP uses that native package only through a private, lazy MCP
stdio syntax worker over an empty temporary directory. Its package build rejects
dependencies from the DAP bundle into Workbench indexing or daemon lifecycle.

## Prepare a release

Start from a clean `main` synchronized with `origin/main`.

1. Update the extension version and its lockfile:

   ```bash
   npm --prefix vscode-extension version 1.4.0 --no-git-tag-version
   ```

2. Add a dated, non-empty `## [1.4.0]` section to
   `vscode-extension/CHANGELOG.md`. The release workflow extracts GitHub Release
   notes from this exact heading.
3. Update user documentation when behavior, requirements, commands, or
   compatibility changed.
4. Run the local release gate:

   ```bash
   npm ci
   npm --prefix vscode-extension ci
   npm run check
   npm run check:architecture
   npm run typecheck
   npm test
   npm run test:e2e
   npm run test:e2e:legacy
   npm --prefix vscode-extension run test:min-vscode
   npm --prefix vscode-extension run test:acceptance
   npm run package:ext
   node scripts/extension/check-marketplace-media.mjs --release
   ```

   The last one refuses a showcase card that is written but was never filmed. If
   it names a scene, capture it before going further:

   ```bash
   npm run marketplace:media -- capture <scene>
   npm run marketplace:media -- validate
   ```

   then show it in `vscode-extension/README.md` and drop its `"card": "pending"`
   from `docs/marketplace-showcase.json`.

5. Inspect the generated host artifact
   `vscode-extension/postgresql-workbench-<version>-<target>.vsix`.

The VSIX must contain:

- `dist/extension.js`;
- `dist/dap-server.js`;
- README, changelog, license, support, security, and third-party notices.

It must not contain TypeScript sources, tests, workspace files, source maps,
declarations, development configuration, `node_modules`, or WASM parser artifacts.

Install the local artifact into a clean VS Code profile:

```bash
code --install-extension \
  vscode-extension/postgresql-workbench-1.4.0-darwin-arm64.vsix \
  --force
```

Complete the manual smoke test described below before tagging.

## Create the release

Commit and push the version, lockfile, changelog, documentation, and code
changes. Confirm that CI is green for that exact commit.

Create an annotated tag whose version exactly matches
`vscode-extension/package.json`:

```bash
git tag -a extension-v1.4.0 -m "PostgreSQL Workbench 1.4.0"
git push origin main extension-v1.4.0
```

Pushing the tag starts the `Extension Release` workflow. Its jobs:

1. verifies that the tagged commit belongs to the history of `main`;
2. verifies the tag-to-manifest version contract;
3. reruns formatting, type checks, unit tests, PostgreSQL integration tests,
   real VS Code tests, the minimum VS Code suite, and legacy pldebugger tests;
4. build and validate the four target-specific VSIX files on their native hosts;
5. create a SHA-256 integrity checksum for each artifact;
6. generate signed GitHub artifact attestations for all four VSIX files;
7. upload the exact VSIX set as the `marketplace-vsix` workflow artifact;
8. creates the GitHub Release using the matching changelog section;
9. attach the exact VSIX files and checksums to the GitHub Release.

Track the workflow with:

```bash
gh run list --workflow release-extension.yml
gh run watch <run-id> --exit-status
```

Do not move an existing release tag to a different commit. If the tagged source
must change, bump the version and create a new tag.

## Publish to Visual Studio Marketplace

The `publish-marketplace` job starts only after the GitHub Release job succeeds.
It downloads `marketplace-vsix` and publishes each exact platform VSIX with
`vsce publish`. Already published platform artifacts are skipped, so rerunning a
partially successful Marketplace job does not require a new build or version.

### Authentication

Publication uses a dedicated Azure DevOps global Personal Access Token:

- Azure DevOps organization: `galien`;
- token organization scope: **All accessible organizations**;
- permission scope: **Marketplace → Manage** only;
- GitHub environment: `marketplace`;
- GitHub environment secret: `VSCE_PAT`.

Create or rotate the PAT from the
[Azure DevOps token page](https://dev.azure.com/galien/_usersSettings/tokens),
then update GitHub without exposing the value in a command argument:

```bash
gh secret set VSCE_PAT --env marketplace
```

Verify only the presence and update date of the secret:

```bash
gh secret list --env marketplace
```

Never store the PAT in a repository file, workflow file, terminal argument,
issue, log, or release note. Revoke it immediately if it may have been exposed.
Use a dedicated token per repository. Do not copy one publishing credential
across extension repositories: each additional copy expands its exposure, while
separate tokens preserve independent rotation and revocation.

> [!IMPORTANT]
> [Microsoft will retire all global Azure DevOps PATs on December 1,
> 2026](https://devblogs.microsoft.com/devops/retirement-of-global-personal-access-tokens-in-azure-devops/).
> After that date, Marketplace automation must use Microsoft Entra
> authentication. Manual upload of the validated GitHub Release VSIX remains the
> fallback.

### Environment protection

The publish job uses the protected GitHub `marketplace` environment:

- only tags matching `extension-v*` may deploy;
- `ng-galien` must explicitly approve the Marketplace job;
- self-review remains enabled because the repository currently has one
  maintainer.

The environment secret is unavailable to the job until approval. Environment
approval delays only Marketplace publication; the validated GitHub Release,
checksum, and provenance attestation already exist at that point.

If a second trusted maintainer is added, require that maintainer as a reviewer
and enable **Prevent self-review**.

## Manual smoke test

Run this sequence against both the local VSIX before tagging and the Marketplace
build after publication:

1. Open a clean VS Code window on the repository.
2. Start or connect to a PostgreSQL 17 database with `pldbgapi`.
3. Open `demo/demo.sql` and select the connection from a call-site CodeLens.
4. Debug a scalar-returning call and verify source opening, breakpoint binding,
   stepping, result rendering, and clean session termination.
5. Debug record, array, and `SETOF` calls and verify collapsed and expanded
   variable rendering.
6. Run at least three call-site debug sessions consecutively. Confirm that each
   session reaches the correct source, `Continue` terminates when no later
   breakpoint exists, results remain visible, and no stale backend remains.
7. Verify the session view reports the function, backend, and lifecycle state
   while a debug session is active.
8. Install the Marketplace build in a clean profile and repeat one scalar and
   one record smoke test.

## Failure recovery

### CI failure

Fix the cause on the branch and rerun the failed CI jobs. For VS Code integration
failures, inspect the `vscode-test-logs` artifact before changing timing or
lifecycle behavior.

### Release job fails before creating the GitHub Release

- If no source change is required, correct external state such as an unavailable
  service and rerun the failed job.
- If source, version, or changelog changes are required, create a new version and
  tag. Do not move the existing tag.

### GitHub Release exists but Marketplace publication fails

First check whether the version is already visible on the
[Marketplace extension page](https://marketplace.visualstudio.com/items?itemName=ng-galien.postgresql-workbench).
If it is not:

1. verify or rotate `VSCE_PAT`;
2. update the GitHub environment secret;
3. rerun only the failed `publish-marketplace` job.

Do not rebuild the extension during recovery.

### Manual publication fallback

Download the platform VSIX attached to the GitHub Release, verify its checksum, and
verify its build provenance:

```bash
gh attestation verify postgresql-workbench-<version>-<target>.vsix \
  --repo ng-galien/postgresql-workbench
```

Upload that exact file through the
[Marketplace publisher page](https://marketplace.visualstudio.com/manage/publishers/ng-galien).
Never package a replacement locally for the same released version.

## Post-publication verification

After publication:

1. verify the version, changelog, Marketplace link, badges, and images on the
   public Marketplace page;
2. verify the [documentation site](https://ng-galien.github.io/postgresql-workbench/)
   matches the released extension and that its feature media and reference links load;
3. install the Marketplace version in a clean VS Code profile;
4. complete the manual smoke test;
5. confirm the GitHub Release VSIX and Marketplace version are identical in
   version and expected behavior;
6. verify the GitHub build-provenance attestation;
7. retain the SHA-256 file as the integrity checksum for the published artifact.

The `extension-v*` tag also triggers the GitHub Pages workflow. Confirm that
the Pages deployment for the release commit succeeds before considering the
release complete.

## Publish the standalone npm packages

Three independently versioned packages can be released without publishing the
VS Code extension:

| Package | Manifest | Tag | Workflow |
| --- | --- | --- | --- |
| `@ng-galien/postgresql-catalog` | `packages/catalog/package.json` | `catalog-v<version>` | `release-catalog.yml` |
| `@ng-galien/postgresql-coverage` | `packages/coverage/package.json` | `coverage-v<version>` | `release-coverage.yml` |
| `@ng-galien/postgresql-dap` | `packages/dap/package.json` | `dap-v<version>` | `release-dap.yml` |

Each workflow requires the tag commit to be contained in `main`, checks that the
tag exactly matches its manifest version, rebuilds and tests the distribution,
packs one minimal tarball, verifies its checksum, attests it, publishes that exact
artifact to npm, and attaches it to a dedicated GitHub Release. Package tags do
not publish the extension or trigger a Marketplace release.

Before creating a release commit, update only the package being released and run
its local gates:

```bash
# Catalog: ESM library, TypeScript declarations, isolated install and npm ci
npm run test:catalog:package

# Coverage: CJS/ESM library, CLI and TypeScript declarations
npm run test:coverage:package
npm run test:e2e:up
PGHOST=127.0.0.1 PGPORT=5433 PGDATABASE=testdb \
  PGUSER=postgres PGPASSWORD=postgres \
  npm run test:coverage:package -- --e2e
npm run test:e2e:down

# DAP: library/runtime package plus real PostgreSQL and compatibility paths
npm run build:dap
npm run test:dap
npm run test:dap:package
npm run test:e2e:up
npm run test:e2e:dap
npm run test:dap:package -- --e2e
npm run test:e2e:down
npm run test:e2e:legacy
```

Commit and push the release preparation on `main`. Only with explicit publication
authorization, create and push the annotated tag for that package, for example:

```bash
git tag -a catalog-v0.1.0 -m "PostgreSQL Catalog 0.1.0"
git push origin main catalog-v0.1.0

git tag -a coverage-v0.1.0 -m "PostgreSQL Coverage 0.1.0"
git push origin main coverage-v0.1.0

git tag -a dap-v0.1.0 -m "PostgreSQL DAP 0.1.0"
git push origin main dap-v0.1.0
```

### npm trusted publishing

All publish jobs use the protected GitHub environment named `npm` and request
`id-token: write`. After the packages exist on npm, configure one trusted
publisher per package with these exact values:

| npm package | GitHub organization | Repository | Workflow filename | Environment |
| --- | --- | --- | --- | --- |
| `@ng-galien/postgresql-catalog` | `ng-galien` | `postgresql-workbench` | `release-catalog.yml` | `npm` |
| `@ng-galien/postgresql-coverage` | `ng-galien` | `postgresql-workbench` | `release-coverage.yml` | `npm` |
| `@ng-galien/postgresql-dap` | `ng-galien` | `postgresql-workbench` | `release-dap.yml` | `npm` |

The GitHub `npm` environment must accept only the three package tag families and
should require explicit approval. The workflows use npm 11.5.1 or newer on
Node.js 24 and publish public scoped packages with provenance.

The first publication of each package must establish its npm entry before its
trusted publisher can be configured. Publish the real validated tarball manually
with an authenticated maintainer session and npm's security-key verification.
Do not create placeholder packages or grant a scope-wide bootstrap token access
to unrelated packages. This initial manual version does not have GitHub provenance.

After the initial publications:

1. configure the three exact trusted publishers above, allowing `npm publish`;
2. increment each package version and commit the release on `main`;
3. push the corresponding package tags and approve the protected environment;
4. verify that the new versions published by GitHub Actions include npm provenance.

The `0.1.0` packages establish the registry entries; `0.1.1` is the first release
intended for GitHub trusted publishing. The workflows use only OIDC, with no npm
token stored in GitHub. To configure an existing package from the authenticated
CLI, use `npm trust github <package> --repo ng-galien/postgresql-workbench
--file release-<package>.yml --env npm --allow-publish` (substitute the exact
package name and workflow filename from the table).

Every publish step compares registry integrity with the validated tarball before
doing anything. An exact existing publication is accepted; a mismatch fails the
release. GitHub Release creation is also idempotent, so a rerun replaces the
validated tarball and checksum instead of creating a second release.

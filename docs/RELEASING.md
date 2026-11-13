# Releasing

How a version of the desktop app is cut, and what signing and a macOS build would take.
Today nothing is signed and nothing is published automatically: a release is an installer
built on a developer machine (or downloaded from CI) and handed over.

## Cutting a release

1. **Start clean and green.** On `master`, with a clean tree:

   ```bash
   npm ci
   npm run typecheck && npm run lint && npm test
   ```

2. **Version.** Set `version` in `package.json` (SemVer) and run `npm install` once so
   `package-lock.json` carries the same number. The installer's file name and the app's
   version come from this field.

3. **Changelog.** In `CHANGELOG.md`, move what is under `[Unreleased]` into a new
   `## [x.y.z] — YYYY-MM-DD` section and add a row to the version map at the bottom.

4. **Build the installer.**

   ```bash
   npm run dist          # next build + prepare-standalone + electron-builder --win
   ```

   The result is `dist/What About This Book Setup x.y.z.exe`; the unpacked app is in
   `dist/win-unpacked`. The build stops if the standalone output contains an env file, a
   link pointing outside itself, or lacks a required file (`scripts/prepare-standalone.mjs`).

5. **Smoke tests.** All three, each must end with every check passed:

   ```bash
   npm run smoke -- --prod        # the standalone build, run from a copy outside the repo
   npm run smoke -- --packaged    # the packaged app in dist/win-unpacked
   npm run smoke -- --busy-port   # dev mode with port 3000 taken: the app must move
   ```

   They use an empty temporary library and no AWS, so they cost nothing and never touch
   `~/.whataboutthisbook`. They catch a build that ships too little: any "Cannot find
   module" in a response or in the app's output fails the run. What they cannot check is
   a real answer; for that, install the new build and ask one question against your own
   library (this needs a signed-in AWS profile).

6. **If dependencies or imports of `vectra` / `epub2` changed**, look at what the server
   loads and what the build ships:

   ```bash
   npm run trace:server           # per package: size, loaded or never loaded
   ```

7. **Commit, tag, push.** Commit the version and changelog, tag `vx.y.z`, push both. On
   `master`, CI builds a Windows installer and a Linux AppImage and keeps them as workflow
   artifacts for 14 days (`.github/workflows/ci.yml`); neither is signed.

### Linux

`npm run dist:linux` builds an AppImage (`dist/WhatAboutThisBook-x.y.z-x86_64.AppImage`)
and the unpacked app in `dist/linux-unpacked`. Build it on Linux (CI does); building Linux
targets on Windows is not something this project has tried. `npm run smoke -- --packaged`
works there too, under `xvfb-run -a` when there is no display.

## Code signing on Windows

The installer is **unsigned**. When someone downloads and runs it, Windows SmartScreen
shows "Windows protected your PC" with the publisher as unknown; the user has to choose
"More info" → "Run anyway". Browsers may also warn about the download. Signing replaces
"unknown publisher" with the certificate's name; how quickly SmartScreen stops warning
depends on the kind of certificate and on reputation, which is Microsoft's policy and has
changed over time: check their current documentation before buying one.

What it takes:

- **A code signing certificate** from a certificate authority, issued to a person or a
  company. Since 2023 the private keys of publicly trusted code signing certificates must
  live on hardware (a token or an HSM/cloud signing service), so a plain `.pfx` file that
  can be copied to a build machine is, for new certificates, the exception: ask the
  issuer how their certificate is meant to be used from a build.
- **With a certificate file** (`.pfx` / `.p12`), electron-builder signs during
  `npm run dist` when it finds these environment variables:
  - `CSC_LINK`: path, `https://` URL or base64 of the certificate file
  - `CSC_KEY_PASSWORD`: its password
  - `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` do the same for Windows only (useful when
    the same build environment also holds a macOS certificate).

  The same can be put in the `build` field of `package.json`. In the electron-builder
  version this project uses (26.x) the keys are under `win.signtoolOptions`:
  `certificateFile`, `certificatePassword`, and, for a certificate in the Windows
  certificate store or on a token, `certificateSubjectName` or `certificateSha1`. (Older
  guides show `win.certificateFile` directly under `win`; the schema in
  `node_modules/app-builder-lib/scheme.json` is the reference for the installed version.)
  Never commit a certificate or its password; in CI they belong in repository secrets.
- **With a cloud service**, electron-builder 26 has `win.azureSignOptions` for Azure
  Trusted Signing. This project has not used it; read electron-builder's code signing
  page for the required account settings and environment variables before relying on it.

How to tell whether a build is signed: the build log prints "signing with signtool.exe"
for unsigned builds as well, so don't go by that. Check the file:

```powershell
(Get-AuthenticodeSignature "dist\What About This Book Setup x.y.z.exe").Status   # Valid, or NotSigned
```

To make an unsigned build fail instead of passing quietly once signing is set up, set
`win.forceCodeSigning: true`.

## A macOS build

Not set up, and never built. `package.json` only names an icon for `mac`. What it needs:

- **A Mac**, or a `macos-*` runner in GitHub Actions: electron-builder builds macOS
  targets only on macOS.
- **A target and a category** in the `mac` section (for example `dmg` and/or `zip`). The
  icon is a 1024×1024 PNG today; check that electron-builder accepts it as is for macOS
  or wants an `.icns`.
- **A signing identity**: a "Developer ID Application" certificate from a paid Apple
  Developer Program membership. On the Mac it is found in the keychain; in CI it is
  passed as `CSC_LINK` / `CSC_KEY_PASSWORD` (a `.p12` export). An unsigned app is blocked
  by Gatekeeper on other people's Macs.
- **Hardened runtime and notarisation**: apps distributed outside the App Store must be
  notarised by Apple or Gatekeeper refuses them. electron-builder has `mac.hardenedRuntime`,
  `mac.entitlements` and `mac.notarize`, and reads the Apple credentials from the
  environment: `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`, or an App
  Store Connect API key (`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`), or
  `APPLE_KEYCHAIN_PROFILE`. Check the exact combination against the electron-builder
  documentation for the installed version.
- **Things to verify in this app before calling it done**, none of them tried:
  - The local server is started by running the app's own executable as Node
    (`ELECTRON_RUN_AS_NODE` in `electron/main.js`). Under the hardened runtime that may
    need entitlements; it has to be tested on a signed, notarised build.
  - `scripts/electron-smoke.mjs --packaged` knows the Windows and Linux layouts only; the
    macOS path (`dist/mac*/What About This Book.app/Contents/MacOS/...`) has to be added.
  - The window uses `titleBarStyle: "hidden"` with a Windows-style overlay; check how it
    looks with macOS window buttons.
  - Signing in to AWS runs the `aws` CLI found on `PATH` (`src/lib/bedrock-client.ts`). An
    app started from Finder gets a shorter `PATH` than a terminal, so the CLI may not be
    found there.

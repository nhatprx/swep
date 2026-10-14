<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="logo-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="logo-light.png">
    <img alt="Swep Logo" src="logo-light.png" width="480">
  </picture>
</p>

<p align="center">
  Portable workspace sessions for multi-device developers — Instant ephemeral Chrome sessions across your machines without master password exposure.
</p>

<p align="center">
  <a href="https://github.com/nhatprx/swep/releases"><img src="https://img.shields.io/github/v/tag/nhatprx/swep?label=release&style=flat-square" alt="Release Tag"></a>
  <a href="https://www.npmjs.com/package/@nhatprx/swep"><img src="https://img.shields.io/npm/v/@nhatprx/swep?style=flat-square" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/nhatprx/swep?style=flat-square" alt="License"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18.0.0-339933.svg?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/platform-Windows-0078D6.svg?style=flat-square&logo=windows&logoColor=white" alt="Platform">
</p>

--- 
### Prerequisites

- Windows 10 or later
- Node.js 18.0.0 or later
- Google Chrome

If Node.js is not installed:

```powershell
winget install OpenJS.NodeJS.LTS
```

### Installation

Install Swep globally using npm:

```powershell
npm install -g @nhatprx/swep
```

## Features

- One-Command Setup: Install globally via npm and run directly in PowerShell.
- Isolated Chrome Profiles: Launch separate browser instances without modifying primary personal profiles.
- Encrypted Capsule Storage: Encrypt workspace data locally using client-side cryptographic keys before syncing to GitHub.
- Cross-Device Mobility: Seamlessly resume your workspace on any supported Windows machine using your login code.
- Instant Session Recovery: Quickly reopen closed browser sessions with `swep open`.
- Automated Cleanup: Synchronize encrypted backup state and purge ephemeral local workspace files upon exit.
- Built-in Diagnostics: Verify system prerequisites, registry configurations, and connectivity using `swep doctor`.

## CLI Commands

| Command | Alias | Description |
|---|---|---|
| `swep <code>` | `swep up`, `swep login` | Restore session data and launch an isolated browser profile. |
| `swep open` | `swep chrome` | Reopen the active isolated browser session. |
| `swep checkout` | - | Log out active key and reset profile data while retaining Swep. |
| `swep exit` | `swep down` | Back up session, close browser, and purge local workspace files. |
| `swep register` | - | Initialize account and encrypted vault. |
| `swep doctor` | - | Diagnose environment prerequisites and network connectivity. |
| `swep recover` | - | Recover vault access using the Recovery Key. |
| `swep revoke` | - | Revoke active access codes and disable vault access. |
| `swep cortex` | `swep status`, `swep habits` | Inspect workspace context, running dev ports, and habit predictions. |
| `swep update` | - | Check and update Swep to the latest release. |
| `swep -v` | `swep --version` | Display installed version. |

## Security

- Client-Side Encryption: Sensitive data is encrypted on the local machine before upload.
- Modern Cryptography: Authenticated encryption powered by XSalsa20-Poly1305 (TweetNaCl) and Argon2id key derivation.
- Zero Application Server: Stores encrypted capability blobs in GitHub Secret Gists without middleman application servers.
- Local Profile Isolation: Ephemeral browser profiles remain strictly segregated from personal browser profiles.
- Vulnerability Reporting: For security disclosures, please consult [SECURITY.md](SECURITY.md) to report issues privately.

## License

This project is licensed under the [MIT License](LICENSE).

### Third-Party Licenses

Swep depends on the following open-source libraries:

- TweetNaCl: Public Domain
- Argon2: Apache License 2.0 / CC0 1.0
- CryptoJS: MIT License
- Commander.js: MIT License
- Chalk: MIT License
- Ora: MIT License
- Axios: MIT License
- Dotenv: BSD-2-Clause License

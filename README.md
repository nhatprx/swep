# Swep
> An ephemeral workspace manager with isolated Chrome profiles.
> **One command to start. Your workspace, ready to go.**

![Version](https://img.shields.io/badge/version-0.1.0-blue.svg?style=for-the-badge)
![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-339933.svg?style=for-the-badge&logo=nodedotjs&logoColor=white)
![Platform](https://img.shields.io/badge/platform-Windows-0078D6.svg?style=for-the-badge&logo=windows&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-yellow.svg?style=for-the-badge)

## Features

- **One-Command Setup:** Install Swep on a Windows machine directly from PowerShell without manually cloning the repository.
- **Isolated Chrome Profiles:** Launch a dedicated Chrome profile without interfering with your primary browser profile.
- **Session Restoration:** Restore supported browser session data from an encrypted Profile Capsule.
- **Encrypted Cloud Vault:** Store encrypted workspace data in your GitHub repository using client-side encryption.
- **Cross-Device Workspaces:** Resume your supported browser session on another Windows device using your login code.
- **Quick Chrome Recovery:** Reopen your current Swep browser session instantly with `swep chrome`.
- **Automated Cleanup:** Back up session data and remove Swep's managed local files when your session ends.
- **Recovery Key:** Recover access to your encrypted vault using a separately generated recovery key.
- **Built-in Diagnostics:** Check system prerequisites, Chrome, Node.js, Registry configuration, and network connectivity with `swep doctor`.

## Quick Start

### Yêu cầu tiên quyết:
Máy cần cài đặt **Node.js (>= 18.0.0)** trước khi sử dụng.
> Nếu máy chưa có Node.js, bạn có thể cài nhanh bằng lệnh Windows:
> ```powershell
> winget install OpenJS.NodeJS.LTS
> ```

### Cài đặt Swep (1 lệnh duy nhất):
Mở terminal và chạy:
```powershell
npm i -g @nhatprx/swep
```

Sau khi cài đặt xong, bạn có thể sử dụng ngay lệnh `swep` trên toàn hệ thống.

## Usage

### 1. Register Your Account

Run this command on your trusted device:

```powershell
swep register
```

Initialize your encrypted vault, configure GitHub access, and generate your login code and Recovery Key.

### 2. Start Your Workspace

On any supported Windows device, run:

```powershell
swep <login-code>
```

Swep retrieves your encrypted vault, restores the supported Profile Capsule data, and launches Chrome with an isolated profile.

### 3. Reopen Chrome

If you close the browser accidentally, run:

```powershell
swep chrome
```

Alias: `swep open`

### 4. Finish Your Session

When your work is complete, run:

```powershell
swep exit
```

Alias: `swep down`

Swep is designed to back up your encrypted session data, close Chrome, and remove its managed local installation files.

## CLI Commands

| Command | Alias | Description |
|---|---|---|
| `swep <code>` | `swep up`, `swep login` | Restore a session and launch an isolated Chrome profile. |
| `swep chrome` | `swep open` | Reopen the current Swep Chrome session. |
| `swep exit` | `swep down` | Back up session data and clean up the local workspace. |
| `swep register` | — | Initialize the account and encrypted vault. |
| `swep -v` | `swep --version` | Display the current version. |
| `swep doctor` | — | Diagnose system and connectivity issues. |
| `swep recover` | — | Recover vault access using the Recovery Key. |
| `swep revoke` | — | Revoke access codes and disable vault access. |

## Security

- **Client-Side Encryption:** Designed to encrypt sensitive data locally before uploading it to GitHub.
- **Modern Cryptography:** Uses ChaCha20-Poly1305 AEAD and Argon2id for authenticated encryption and key derivation.
- **No Separate Application Server:** Uses GitHub for encrypted artifact storage and distribution.
- **Local Profile Isolation:** Keeps the Swep Chrome profile separate from your primary Chrome profile.
- **Access Recovery:** Provides a Recovery Key for supported account recovery workflows.

Security depends on the implementation, key management, GitHub token permissions, and the security of the device running Swep. Restored browser sessions may require additional authentication, and deleting Swep's managed files does not guarantee removal of every operating-system or browser artifact.

## Requirements

- Windows
- PowerShell
- Node.js 18.0.0 or later
- Google Chrome
- GitHub account and a Personal Access Token with the required permissions

## License

Released under the [MIT License](LICENSE).

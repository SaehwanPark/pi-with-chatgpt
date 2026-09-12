---
layout: default
title: Configuration Guide
permalink: /configuration/
---

# Configuration Guide

[Home]({{ site.baseurl }}/) | [Getting Started]({{ site.baseurl }}/getting-started/) | [User Guide]({{ site.baseurl }}/user-guide/) | [Agent Tools]({{ site.baseurl }}/agent-tools/) | [Configuration]({{ site.baseurl }}/configuration/) | [Drift]({{ site.baseurl }}/drift-and-disposition/) | [Troubleshooting]({{ site.baseurl }}/troubleshooting/) | [Architecture]({{ site.baseurl }}/architecture-and-safety/)

---

`pi-with-chatgpt` is designed with **safe, zero-configuration defaults**. For most development environments, no manual configuration is required. When customization is needed, the configuration system is strictly validated to prevent security mistakes (INV-12).

---

## Configuration Scopes & Locations

Configuration can be applied at two levels:

1. **Global User Scope**: `~/.pi/agent/settings.json`
   Controls default settings across all repositories on your workstation.
2. **Project Workspace Scope**: `.pi/agent.json` (inside repository root)
   Overrides specific options for the local repository.

```json
{
  "pi-with-chatgpt": {
    "dependencyDefault": "advisory",
    "defaultMode": "sync",
    "syncTimeoutMs": 240000,
    "pollIntervalMs": 5000,
    "autoConsult": {
      "enabled": false,
      "confirmBeforeDispatch": true
    },
    "browserExecutablePath": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "logLevel": "info"
  }
}
```

---

## Configuration Options

| Option | Type | Default | Allowed Values | Scope Authority |
| --- | --- | --- | --- | --- |
| `enabled` | boolean | `true` | `true`, `false` | Global, Project |
| `dependencyDefault` | string | `"advisory"` | `"advisory"`, `"required"` | **Global only** for `"required"` |
| `defaultMode` | string | `"sync"` | `"sync"`, `"async"` | Global, Project |
| `syncTimeoutMs` | number | `240000` | `5000` to `900000` (5s to 15m) | Global, Project |
| `pollIntervalMs` | number | `5000` | `1000` to `600000` (1s to 10m) | Global, Project |
| `autoConsult.enabled` | boolean | `false` | `true`, `false` | **Global only** |
| `autoConsult.confirmBeforeDispatch` | boolean | `true` | `true`, `false` | Global, Project |
| `browserExecutablePath` | string | *auto-detected* | Absolute file path | **Global only** |
| `logLevel` | string | `"info"` | `"silent"`, `"info"`, `"verbose"` | Global, Project |

---

## Option Details

### `dependencyDefault` (`"advisory"` | `"required"`)
Controls whether a failure to reach or consult ChatGPT blocks your Pi worker:
- `"advisory"` (default): Non-blocking (INV-07). If ChatGPT is down, rate-limited, or session expired, Pi logs an advisory warning and continues working with the local model.
- `"required"`: Strict gate. If the adviser fails, execution halts (`blocked: true`) until resolved.
> [!SECURITY]
> **Project Scope Restriction**: A cloned repository *cannot* set `dependencyDefault: "required"`. Cloned untrusted repositories must never be able to force denial of service on local agent execution.

### `defaultMode` (`"sync"` | `"async"`)
- `"sync"`: Slash commands and tools wait for the consultation turn to finish (up to `syncTimeoutMs`) before returning to the prompt.
- `"async"`: Consultations are dispatched in the background. The command returns immediately with a job ID, allowing you and Pi to continue working uninterrupted.

### `syncTimeoutMs` (number, milliseconds)
The maximum duration Pi will wait for a synchronous consultation turn. Defaults to `240000` (4 minutes). If ChatGPT takes longer (e.g. generating extensive architectural documents or deep reasoning), the turn times out safely without crashing.

### `pollIntervalMs` (number, milliseconds)
The polling frequency used when monitoring asynchronous jobs. Defaults to `5000` (5 seconds). Kept intentionally coarse to avoid hammering the local Playwright browser process.

### `autoConsult` (object)
Allows Pi worker models to suggest consultations automatically at high-leverage architectural moments:
- `enabled` (boolean, default `false`): Enables heuristic triggers (e.g. major structural changes, security-sensitive edits). Must be enabled in user global settings.
- `confirmBeforeDispatch` (boolean, default `true`): Prompts the user before dispatching an auto-consultation to GitHub and ChatGPT.

### `browserExecutablePath` (string, optional)
Explicit file path to Google Chrome or Chromium executable. If omitted, Playwright automatically discovers the system Chrome installation.
> [!SECURITY]
> **Profile Path Rejection**: This path must point to an executable binary, never to a user profile directory (`Default`, `User Data`, etc.). The extension strictly refuses any path that resembles a user browser profile.

---

## Security Guarantee: Rejection of Credential Keys (INV-12)

Any attempt to specify credentials or tokens in configuration is **strictly rejected**:

```json
// THIS WILL THROW A CONFIG ERROR ON STARTUP:
{
  "pi-with-chatgpt": {
    "apiKey": "sk-...",
    "sessionToken": "..."
  }
}
```

The extension throws:
```text
ConfigError: "apiKey" is not a configuration option. ChatGPT authentication lives
in the extension-owned browser profile and is never supplied through configuration.
```

This prevents accidental check-ins of API keys or session cookies to version control.

---

## Environment Variables

| Variable | Description |
| --- | --- |
| `GH_TOKEN` / `GITHUB_TOKEN` | Optional GitHub Personal Access Token. Used solely for querying GitHub API endpoints (e.g. PR numbers or commit presence) via read-only requests. |
| `PI_ADVISER_LOG_LEVEL` | Override log level (`silent`, `info`, `verbose`). |

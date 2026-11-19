// Purpose: Pins the complete native runtime artifacts shipped with this app release.
import type { NativeProviderID } from "@openchart/models/model-tiers";

/** Immutable download contract; the artifact host is never an updater. */
export interface RuntimeArtifact {
  readonly version: string;
  readonly url: string;
  /** SRI `sha512-<base64>` of the downloaded archive. */
  readonly integrity: string;
  /**
   * Archive shape: `npm` tarballs keep every entry under `package/`, which
   * installation strips; `flat` release archives keep entries at the root.
   */
  readonly layout: "npm" | "flat";
  /** ZIP archives opt in; omitted means tar.gz and preserves existing install identities. */
  readonly archive?: "zip";
  /** Path of the CLI inside the installed payload. */
  readonly executable: string;
  /**
   * Set when the archive ships the CLI compressed at `<executable>.br`, as
   * Grok's npm packages do for their postinstall script. Installation
   * decompresses it to `executable` and removes the compressed copy.
   */
  readonly compression?: "brotli";
}
/** App-pinned archives per runtime id and `<platform>-<arch>`. */
export type RuntimeManifest<Id extends string> = Readonly<
  Record<Id, Readonly<Record<string, RuntimeArtifact>>>
>;
/**
 * Platform-specific pins. Update Claude SDK dependencies together with its artifacts.
 * Antigravity publishes flat GitHub release archives, including ZIPs on Windows.
 * Grok's npm platform packages ship the CLI Brotli-compressed.
 */
export const PROVIDER_MANIFEST: RuntimeManifest<NativeProviderID> = {
  codex: {
    "darwin-arm64": {
      version: "0.170.0",
      url: "https://registry.npmjs.org/@openai/codex/-/codex-0.170.0-darwin-arm64.tgz",
      integrity:
        "sha512-sQyOGJabAUTEWCKe1O6GNsE7NKnHCHSjzLrazfYUgw8OFsFDeAQGVEwzvpXTK1yW1hJiLLAMRzC/W2Vu7m9DwQ==",
      layout: "npm",
      executable: "vendor/aarch64-apple-darwin/bin/codex",
    },
    "darwin-x64": {
      version: "0.170.0",
      url: "https://registry.npmjs.org/@openai/codex/-/codex-0.170.0-darwin-x64.tgz",
      integrity:
        "sha512-lniwntVB9YaCQNNaTgpLxVvABkrnZDCO/UZf3z7POwH71ikkVNi7NxBrfl6aSIS9b3UBJKxjPlAm3qeIxINJVg==",
      layout: "npm",
      executable: "vendor/x86_64-apple-darwin/bin/codex",
    },
    "linux-arm64": {
      version: "0.170.0",
      url: "https://registry.npmjs.org/@openai/codex/-/codex-0.170.0-linux-arm64.tgz",
      integrity:
        "sha512-mJLm5eia/GcukCrRfVEnYVD5dOXGE7cmpd9dJ/ixkSiKifzDAPaGq83ZEmwVhk3PxbdTPUSLRpnXZQKbNS5HoA==",
      layout: "npm",
      executable: "vendor/aarch64-unknown-linux-musl/bin/codex",
    },
    "linux-x64": {
      version: "0.170.0",
      url: "https://registry.npmjs.org/@openai/codex/-/codex-0.170.0-linux-x64.tgz",
      integrity:
        "sha512-6cCZJaZL17tiTAvhd1Pirt8vsV1dP8CfG94+IHygUO4m24oYLQrIInJJLyKzcMv/uUonbu1dF2JmcXhA/s5bsg==",
      layout: "npm",
      executable: "vendor/x86_64-unknown-linux-musl/bin/codex",
    },
    "win32-arm64": {
      version: "0.170.0",
      url: "https://registry.npmjs.org/@openai/codex/-/codex-0.170.0-win32-arm64.tgz",
      integrity:
        "sha512-VSfDt/Y/RYqeT+9gCwmIO1kEj7bF7RYQdhanhMWQqWpZBdPLrF19z2z8JbL+Gt/amE7A1d/Rt2g/p44DLrDhFg==",
      layout: "npm",
      executable: "vendor/aarch64-pc-windows-msvc/bin/codex.exe",
    },
    "win32-x64": {
      version: "0.170.0",
      url: "https://registry.npmjs.org/@openai/codex/-/codex-0.170.0-win32-x64.tgz",
      integrity:
        "sha512-eNlCGvSTKMegqo1R0PPfAf0jOQp8OGfWH8WX2UyTtRN6E/YOecJnz4n1X9lIb02O8Zda/Lv6/WST7+8mufTVSw==",
      layout: "npm",
      executable: "vendor/x86_64-pc-windows-msvc/bin/codex.exe",
    },
  },
  "claude-code": {
    "darwin-arm64": {
      version: "2.1.284",
      url: "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-darwin-arm64/-/claude-agent-sdk-darwin-arm64-0.3.284.tgz",
      integrity:
        "sha512-gKY9MUjY83398uCiPLHsd87kyzu7agIM7ApqWpJkpSINep6hxx4rNoR8bUbNWg49Aoe/PW/DJkQByAQuNzR9rg==",
      layout: "npm",
      executable: "claude",
    },
    "darwin-x64": {
      version: "2.1.284",
      url: "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-darwin-x64/-/claude-agent-sdk-darwin-x64-0.3.284.tgz",
      integrity:
        "sha512-P+q6Z7sKeYz99uE7RJc4au1IK+4SiWe69pyHY3QXMnjZq8hSFU/5Mo8iSurLk9jRlihsMltV1rLA5naouYyCAQ==",
      layout: "npm",
      executable: "claude",
    },
    "linux-arm64": {
      version: "2.1.284",
      url: "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-linux-arm64/-/claude-agent-sdk-linux-arm64-0.3.284.tgz",
      integrity:
        "sha512-LDpuYDaz+pCdG29iy1pw4P1D2YVtpZOb4rWOPxxSpg2fFyUeQ5WrfnuszOxhDWpNh1k1ekDiKm3A9OzGcrkdtA==",
      layout: "npm",
      executable: "claude",
    },
    "linux-x64": {
      version: "2.1.284",
      url: "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-linux-x64/-/claude-agent-sdk-linux-x64-0.3.284.tgz",
      integrity:
        "sha512-yGytBCCwJvWeg1FzFpgnLM9BOM2vKVExtv6pMJHMtF82J5yhKHcxodRaYlQVd/HzJJ2nruKb9EnrhRBZ//4yRw==",
      layout: "npm",
      executable: "claude",
    },
    "win32-arm64": {
      version: "2.1.284",
      url: "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-win32-arm64/-/claude-agent-sdk-win32-arm64-0.3.284.tgz",
      integrity:
        "sha512-zOXkdPHhElyxyFJ6eY5R+YGUswqBDZ+ZHNaRmQGJ28RkQYgwG5imNy/nfFR+/CPGlMnH9ZzbGc2rKYApm1K4Tg==",
      layout: "npm",
      executable: "claude.exe",
    },
    "win32-x64": {
      version: "2.1.284",
      url: "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-win32-x64/-/claude-agent-sdk-win32-x64-0.3.284.tgz",
      integrity:
        "sha512-VGaFRDCOPloj5IjvJTyy5JsSl9sE2HR3W+A6f/cjgh23/7Y5vK7/ka+1JQD+AkoGO9tbHqP2O6god3IBrLvOaw==",
      layout: "npm",
      executable: "claude.exe",
    },
  },
  antigravity: {
    "win32-x64": {
      version: "1.5.12",
      url: "https://github.com/google-antigravity/antigravity-cli/releases/download/1.5.12/agy_cli_windows_x64.zip",
      integrity:
        "sha512-sBLSIiGyfRn0E4jLfXsWyAuaXUr+q6FYqkv125kTjR5O8iptSLVc7PXAw8shmxpfLw9dGiJd3KXV1Kq1YWqAFw==",
      layout: "flat",
      archive: "zip",
      executable: "antigravity.exe",
    },
    "darwin-arm64": {
      version: "1.5.12",
      url: "https://github.com/google-antigravity/antigravity-cli/releases/download/1.5.12/agy_cli_mac_arm64.tar.gz",
      integrity:
        "sha512-8NlRtBvdtiy+4BmaYMyamroWzsuVxc99XHE0nHRcV48tK7zhGUsFjoZ+hUVgMKwbHscncu4Xsx3h1gbzTM4xVA==",
      layout: "flat",
      executable: "antigravity",
    },
    "darwin-x64": {
      version: "1.5.12",
      url: "https://github.com/google-antigravity/antigravity-cli/releases/download/1.5.12/agy_cli_mac_x64.tar.gz",
      integrity:
        "sha512-s5LpTlk6PJPpCxTid8gOlxLBRC26D2intIkYu+uZAlClRO7feRQm06/ZUWISi03jIPVJ8mOWQNIOHSW1Z3hMfw==",
      layout: "flat",
      executable: "antigravity",
    },
    "linux-arm64": {
      version: "1.5.12",
      url: "https://github.com/google-antigravity/antigravity-cli/releases/download/1.5.12/agy_cli_linux_arm64_musl.tar.gz",
      integrity:
        "sha512-U3nioGELQA4vcVLRuj8FAMd1lZrBxSszjGvPFefmwDJL8ne79ORjPLE3fv1C+qdokpT/CDd7thZE07qezEn5pg==",
      layout: "flat",
      executable: "antigravity",
    },
    "linux-x64": {
      version: "1.5.12",
      url: "https://github.com/google-antigravity/antigravity-cli/releases/download/1.5.12/agy_cli_linux_x64_musl.tar.gz",
      integrity:
        "sha512-RJmyohJ98biWAc6Byaqhqqeq1tKCusjH7YorIOH1wr7EO9X/zTvn6iWNcgXPSRHNmVEUwxHfe/LQf799NRjk+g==",
      layout: "flat",
      executable: "antigravity",
    },
  },
  grok: {
    "darwin-arm64": {
      version: "1.0.62",
      url: "https://registry.npmjs.org/@xai-official/grok-darwin-arm64/-/grok-darwin-arm64-1.0.62.tgz",
      integrity:
        "sha512-RSfT2HoNR9lN7ji6lR2HC9Sz0DJLKTCPRXGtQFL4XDmZU+SFLZ8DzKKbqIfS+odHVQ2FnSLaBGud8Os8ghYpdA==",
      layout: "npm",
      executable: "bin/grok",
      compression: "brotli",
    },
    "darwin-x64": {
      version: "1.0.62",
      url: "https://registry.npmjs.org/@xai-official/grok-darwin-x64/-/grok-darwin-x64-1.0.62.tgz",
      integrity:
        "sha512-RrzCeHkEFkC7DhU2hTuMe3jKMaLqfFLaGAhUyVPvFOrdEJAehk20VF5M9VLISKVUQrQTO82gwqd/ib83Da+wtg==",
      layout: "npm",
      executable: "bin/grok",
      compression: "brotli",
    },
    "linux-arm64": {
      version: "1.0.62",
      url: "https://registry.npmjs.org/@xai-official/grok-linux-arm64/-/grok-linux-arm64-1.0.62.tgz",
      integrity:
        "sha512-IyxJjZzL8joNPLw/qx9TN4zoSA0vgXIZbOLptadLrP3lOrUV5TzpYT/EwhM9GhHxQGmovrm9oJFbuB+WYeTujQ==",
      layout: "npm",
      executable: "bin/grok",
      compression: "brotli",
    },
    "linux-x64": {
      version: "1.0.62",
      url: "https://registry.npmjs.org/@xai-official/grok-linux-x64/-/grok-linux-x64-1.0.62.tgz",
      integrity:
        "sha512-MsqDUf0rryWKchpO7TBFY/npVTKiBF/4zarOXzBOqd0YVpnSs9P0tZmZdXQ0o95s9e4FTvpy/CgUbuOsiqkyVA==",
      layout: "npm",
      executable: "bin/grok",
      compression: "brotli",
    },
    "win32-arm64": {
      version: "1.0.62",
      url: "https://registry.npmjs.org/@xai-official/grok-win32-arm64/-/grok-win32-arm64-1.0.62.tgz",
      integrity:
        "sha512-X9lRub7ybnGGvtWd5FKO8z8YCQ4SrNRpFrjY2IwcVgbIguVr1VVeLskWwpvASC5cTe7NfMHAMlq8JIQ/NbuZig==",
      layout: "npm",
      executable: "bin/grok.exe",
      compression: "brotli",
    },
    "win32-x64": {
      version: "1.0.62",
      url: "https://registry.npmjs.org/@xai-official/grok-win32-x64/-/grok-win32-x64-1.0.62.tgz",
      integrity:
        "sha512-y03RgVwg13rjXPTPVroDmAKP9H+gJK+2MC8xJgNKRw9aV3wS4eEMqWH3kUyxyBw93zlAPvDWCgSNmDg1j1d2Yw==",
      layout: "npm",
      executable: "bin/grok.exe",
      compression: "brotli",
    },
  },
};

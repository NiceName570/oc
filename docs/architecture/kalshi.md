# Kalshi BTC 15-Minute Trading Integration

OpenChart includes a built-in Kalshi integration for trading **15-minute Bitcoin contracts (`KXBTC15M`)** directly beside a chart without leaving the desktop app. It combines a right-hand dockable side panel (matching Copilot's layout), an optional dashboard widget, and a local Node/Effect tRPC service that signs and submits live production orders.

---

## 1. File Map & Ownership

| Layer                    | File                                                                                                                                                                                                       | Owns                                                                                                                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Server HTTP & Signing    | [server/kalshi/client.ts](../../server/kalshi/client.ts)                                                                                                                                                   | Live production Kalshi Trade API v2 requests, RSA-PSS/Ed25519 signing, single-book YES-leg order translation, buy-side cap check, Coinbase BTC spot lookup, P&L math                             |
| Server Credentials       | [server/kalshi/credentials.ts](../../server/kalshi/credentials.ts)                                                                                                                                         | Encrypted persistence of `apiKeyId`, `privateKeyPem`, and `maxOrderDollars` inside OpenChart's `Credential.Service` under synthetic ID `"kalshi"`                                                |
| Server TP/SL Watcher     | [server/kalshi/bracket-monitor.ts](../../server/kalshi/bracket-monitor.ts)                                                                                                                                 | In-memory `1s` polling watcher for Take Profit / Stop Loss triggers, pre-buy offset target computation, and `reduce_only` IOC auto-exit execution                                                |
| Server tRPC Router       | [server/kalshi/router.ts](../../server/kalshi/router.ts)                                                                                                                                                   | `kalshiRouter` procedures (`status`, `connect`, `disconnect`, `setMaxOrderDollars`, `snapshot`, `placeOrder`, `setBracket`, `clearBracket`) + `10s` balance cache                                |
| Server Entry             | [server/index.ts](../../server/index.ts)                                                                                                                                                                   | Mounts `kalshi: kalshiRouter` on root `router` (typed in client via `@openchart/server/contract`)                                                                                                |
| Server Tests             | [client.test.ts](../../server/kalshi/client.test.ts), [router.test.ts](../../server/kalshi/router.test.ts), [bracket-monitor.test.ts](../../server/kalshi/bracket-monitor.test.ts)                         | Unit tests for signing, order leg mapping, encryption, balance caching, router schemas, and TP/SL execution                                                                                      |
| Feature UI               | [app/src/features/kalshi/components/kalshi-trade-panel.tsx](../../app/src/features/kalshi/components/kalshi-trade-panel.tsx)                                                                               | `KalshiTradePanel` (`transport` prop or `WidgetContext`): `1s` quote polling, `MM:SS` countdown, Strike/Spot distance, Dollars/Shares toggle, 1-click Buy/Sell, TP/SL controls, inline Key setup |
| Dashboard Widget Adapter | [app/src/features/kalshi/components/widget.tsx](../../app/src/features/kalshi/components/widget.tsx)                                                                                                       | Exports `kalshiWidget` (`kind: "kalshi"`, `defaultSize: { w: 3, h: 10 }`, `minSize: { w: 3, h: 8 }`)                                                                                             |
| Widget Registry          | [app/src/app/widgets/widget-registry.ts](../../app/src/app/widgets/widget-registry.ts)                                                                                                                     | Registers `kalshi` in `widgetCatalog` (keep registered to preserve saved dashboards)                                                                                                             |
| App Side Panel & Toggle  | [kalshi-controls.tsx](../../app/src/app/kalshi/kalshi-controls.tsx), [kalshi-side-panel.tsx](../../app/src/app/kalshi/kalshi-side-panel.tsx)                                                               | `KalshiPanelControlsProvider`, `KalshiTrigger` header button, and `KalshiSidePanel` (`ResizableSidePanel` with `id="app-kalshi"`)                                                                |
| App Shell Wiring         | [page-header.tsx](../../app/src/app/page-header.tsx), [layout.tsx](../../app/src/app/layout.tsx)                                                                                                           | Places `<KalshiTrigger />` left of `<CopilotTrigger />` and keeps right-hand Copilot and Kalshi panels mutually exclusive                                                                        |
| Frontend Tests           | [kalshi-trade-panel.test.tsx](../../app/src/features/kalshi/components/__tests__/kalshi-trade-panel.test.tsx), [kalshi-side-panel.test.tsx](../../app/src/app/kalshi/__tests__/kalshi-side-panel.test.tsx) | React Testing Library coverage for sizing, 1-click orders, TP/SL UI, and side-panel toggling                                                                                                     |

---

## 2. Runtime Data & Control Flow

```text
+-------------------------------------------------------------------+
| OpenChart App (Renderer)                                          |
|                                                                   |
|  PageHeader: [KalshiTrigger] [CopilotTrigger]                     |
|       |                                                           |
|       v (mutually exclusive right drawer in layout.tsx)           |
|  KalshiSidePanel (#app-kalshi, 320-800px) OR Dashboard kalshiWidget|
|       |                                                           |
|       v                                                           |
|  KalshiTradePanel                                                 |
|   - Polls snapshot every 1s ONLY while visible=true               |
|   - 1-click Buy YES / Buy NO / Sell (zero confirmation popups)    |
|   - Dollars ($) / Shares sizing toggle                            |
+-----------------------------+-------------------------------------+
                              | tRPC (transport.rpc.kalshi.*)
                              v
+-------------------------------------------------------------------+
| OpenChart Local Server (server/kalshi/router.ts)                  |
|                                                                   |
|  - Decrypts API Key ID + PEM via Credential.Service ("kalshi")    |
|  - Fetches public market (KXBTC15M) + Coinbase BTC-USD spot       |
|  - Caches portfolio balance for 10s (1 req/s Kalshi limit safety) |
|  - Enforces server-side maxOrderDollars cap on buys               |
|  - BracketMonitor runs a 1s setInterval when TP or SL is armed    |
+-------+-------------------------+---------------------------------+
        |                         |
        v                         v
Kalshi Production API v2     Coinbase Public Spot
external-api.kalshi.com      api.coinbase.com/v2/prices/BTC-USD/spot
```

---

## 3. Kalshi Trade API v2 Mechanics

### Base URL & Market Selection

- **Production only:** `https://external-api.kalshi.com/trade-api/v2` (`KALSHI_API_BASE` in [client.ts](../../server/kalshi/client.ts)). There is no demo toggle.
- **Active 15m market lookup:** `GET /trade-api/v2/markets?series_ticker=KXBTC15M&status=open&limit=5`.
  - Filters to markets whose status is empty, `"active"`, or `"open"` with `close_time > nowMs`, sorted ascending by `close_time` so the soonest expiring active contract wins.
  - **Note on quote fields:** Kalshi often quotes prices in sub-cent increments (e.g. `"0.0190"` = `1.9¢`). `parsePriceFallback` reads `*_dollars` strings first and falls back to cent integers `/ 100`. In UI formatting (`formatCents`), remainders `>= 0.05¢` render to 1 decimal place (`1.9¢`); otherwise rounded integer cents (`81¢`).
- **Live BTC Spot & Strike distance:** Fetched concurrently from Coinbase `BTC-USD` spot (`COINBASE_BTC_SPOT_URL`) and compared against Kalshi `floor_strike`: `distanceDollars = spotUsd - strikeDollars`.

### V2 Orders & Single-Book YES-Leg Mapping

- **Active endpoint:** `POST /trade-api/v2/portfolio/events/orders`.
  - **CRITICAL:** Kalshi deprecated `POST /portfolio/orders`; calling it returns **`410 Gone`** (`deprecated_v1_order_endpoint`). Always use `/portfolio/events/orders`.
- **Single-book YES-leg model:** Order V2 accepts YES-leg `side` (`"bid" | "ask"`) and YES-leg `price` (`"0.0100"`–`"0.9900"`), plus `count` formatted to 2 decimals, `time_in_force: "immediate_or_cancel"`, `self_trade_prevention_type: "taker_at_cross"`, and `reduce_only: boolean`:

| User Action | Limit Price Input (`p`) | V2 `side` | V2 `price` (YES-leg) | `reduce_only` |
| ----------- | ----------------------- | --------- | -------------------- | ------------- |
| `buy_yes`   | YES ask (`p`)           | `"bid"`   | `p`                  | `false`       |
| `buy_no`    | NO ask (`p`)            | `"ask"`   | `1 - p`              | `false`       |
| `sell_yes`  | YES bid (`p`)           | `"ask"`   | `p`                  | `true`        |
| `sell_no`   | NO bid (`p`)            | `"bid"`   | `1 - p`              | `true`        |

- **NO fill-price translation:** Because Kalshi reports `average_fill_price` on the YES leg, both [bracket-monitor.ts](../../server/kalshi/bracket-monitor.ts) and [kalshi-trade-panel.tsx](../../app/src/features/kalshi/components/kalshi-trade-panel.tsx) compute `1 - averageFillPrice` whenever displaying or deriving targets for `buy_no` or `sell_no`.

### Request Signing

- Signed string: `${timestampMs}${METHOD}${pathWithoutQuery}` where `timestampMs` is epoch milliseconds and `pathWithoutQuery` **must include** `/trade-api/v2/...` while **stripping `?query` parameters**.
- Supported key types (`validateKalshiPrivateKey`):
  - **RSA / RSA-PSS:** RSA-PSS SHA-256 (`constants.RSA_PKCS1_PSS_PADDING`, `constants.RSA_PSS_SALTLEN_DIGEST`).
  - **Ed25519:** `crypto.sign(null, buffer, key)`.
  - ECDSA and other key types are rejected before persisting.
- Sent headers: `KALSHI-ACCESS-KEY`, `KALSHI-ACCESS-TIMESTAMP`, `KALSHI-ACCESS-SIGNATURE`.

---

## 4. Encrypted Credentials & Risk Caps

- **Local encryption only:** Credentials are encrypted with OpenChart's host master key via `Credential.Service` ([credentials.ts](../../server/kalshi/credentials.ts)) under the synthetic `Integration.IntegrationID.make("kalshi")`, stored in the SQLite `credential` table as `Credential.Key` with `{ apiKeyId, maxOrderDollars }` metadata.
- **No leakage to `access.integration`:** `Integration.Service.listIntegrations()` iterates registered integration definitions rather than raw `credential` rows, so storing `"kalshi"` in `Credential.Service` keeps Kalshi private from the generic Integration directory (verified in [router.test.ts](../../server/kalshi/router.test.ts)).
- **Live verification on connect:** `kalshi.connect` validates the PEM key locally and calls `fetchBalance` against Kalshi **before** writing to SQLite so wrong keys or Key IDs fail immediately.
- **Secret isolation:** Neither `privateKeyPem` nor full `apiKeyId` is ever returned over tRPC or logged; the UI only receives `maskedApiKeyId` (`abcd...wxyz`).
- **Buy-side dollar cap:** `maxOrderDollars` (default `25`) is checked both in the UI and server-side in `assertBuyWithinCap`. **Closing sells (`sell_yes` / `sell_no`) intentionally bypass `maxOrderDollars`** so lowering the cap never traps an open position. `kalshi.setMaxOrderDollars` updates the cap by re-saving from server-decrypted credentials without asking the user to re-paste the PEM key.

---

## 5. Polling, Caching, Sizing & Brackets

### Polling & Caching

- **UI polling:** `KalshiTradePanel` polls `transport.rpc.kalshi.snapshot` every **`1000ms`**, gated by `enabled: visible`. Closing the right-hand drawer stops frontend snapshot polling immediately.
- **Countdown timer:** Local `setInterval(..., 1000)` counts down against `market.closeTime` while `visible` is true.
- **Balance cache:** `router.ts` caches `fetchBalance` for **`10,000ms`** (`BALANCE_CACHE_TTL_MS`) per `apiKeyId` to stay well under Kalshi's 1 req/s balance rate limit. Cache is invalidated on `connect`, `disconnect`, `placeOrder`, and background bracket executions.

### 1-Click Orders & Dollars / Shares Sizing

- **No confirmation popups:** Clicking **Buy YES**, **Buy NO**, or **Sell** submits immediately with in-flight lock (`placeOrderMutation.isPending`) to block accidental double clicks.
- **`Dollars ($)` vs `Shares` toggle:**
  - Defaults to **`Dollars ($)`** (`$5` default, presets `$5`, `$10`, `$25`; switchable to `Shares` with presets `1`, `5`, `10`).
  - Whole contracts per side are floored in Dollar mode via `Math.floor((validAmount + 1e-9) / ask)` so actual spend (`contracts * ask`) never exceeds the entered dollar budget. If `validAmount < ask`, the button disables cleanly and displays `Min $0.XX`.

### Automatic & Adjustable TP / SL ([bracket-monitor.ts](../../server/kalshi/bracket-monitor.ts))

- **Pre-buy offsets:** Optional `Auto TP (+¢)` and `Auto SL (-¢)` inputs are passed to `kalshi.placeOrder`. When a buy fills (`fillCount > 0`), `computeAutoBracketTargets` calculates `entry + tp/100` and `entry - sl/100` clamped to `$0.01–$0.99` (translated via `1 - averageFillPrice` for NO buys) and arms the server monitor.
- **Post-buy adjustments:** Inside the **Open Position** card, users can edit `Take Profit (¢)` / `Stop Loss (¢)` (with live projected P&L previews) and call `kalshi.setBracket` or `kalshi.clearBracket`.
- **1-second execution loop & SL sweep buffer:** While at least one target is armed, `BracketMonitor` polls `fetchActiveBtc15mMarket` every `1000ms`:
  - Verifies the position is still open via `fetchMarketPosition` right before submitting (`reduce_only: true`, `count: openPos.contracts`).
  - **TP trigger:** `exitBid >= takeProfitDollars - 1e-9` -> IOC sell at `limit = takeProfitDollars`.
  - **SL trigger:** `exitBid <= stopLossDollars + 1e-9` -> IOC sell at `limit = max(0.01, exitBid - 0.02)` (a `2¢` sweep floor so rapid drops still fill while preventing catastrophic zero-bid slippage).
  - Clears automatically on full fill (`remainingCount <= 1e-6`), manual closing sell, `snapshot` seeing no open position, `15m` ticker rollover (`status: "closed"`), or `disconnect`.
  - Surfacing events: `lastBracketEvent` returns the latest fill/partial/missed/rollover/error message to the UI in a dismissible alert banner.

---

## 6. Issues & Gotchas to Watch Out For When Editing

1. **Take Profit / Stop Loss is local in-memory only**
   - `BracketMonitor` runs inside OpenChart's local Node process (`server/kalshi/bracket-monitor.ts`), NOT as native resting orders on Kalshi's matching engine.
   - Closing OpenChart or restarting the backend clears any armed TP/SL rule (though open Kalshi positions remain untouched on Kalshi). Keep the user-visible notice (`"Active while OpenChart is open"`) honest unless persistence or resting exchange orders are implemented later.
2. **Effect v4 `Schema.Literals([...])` gotcha**
   - In this repo's Effect `4.0.0-rc.112`, `Schema.Literal("a", "b")` **silently validates only `"a"`** (`SchemaError` at runtime on `"b"`!). Always use **`Schema.Literals(["a", "b"])`** for string-literal unions (see [router.ts](../../server/kalshi/router.ts)).
3. **tRPC 500 error scrubbing**
   - [server/lib/trpc/errors.ts](../../server/lib/trpc/errors.ts) scrubs unrecognized thrown `Error`s to `"Internal server error"`. Mutations in [router.ts](../../server/kalshi/router.ts) therefore return structured `{ ok: true, ... } | { ok: false, error: string }` payloads instead of throwing — preserve this convention when adding mutations so Kalshi API errors (invalid key, cap exceeded, insufficient balance) reach the UI cleanly.
4. **`KalshiPanelControlsContext` default must stay `null`**
   - Unlike `CopilotControlsContext` (which throws outside `CopilotControlsProvider`), [kalshi-controls.tsx](../../app/src/app/kalshi/kalshi-controls.tsx) defaults to `null` so `<PageHeader>` renders cleanly in standalone page/settings tests without requiring every test harness to wrap `KalshiPanelControlsProvider`. Keep `KalshiTradePanel` supporting **both** `propTransport` (side panel) and `WidgetContext` (dashboard card).
5. **Keep `kalshi` registered in `widget-registry.ts`**
   - Even though the primary UX is the right-hand `KalshiSidePanel`, users with existing dashboards that placed `kind: "kalshi"` rely on [widget-registry.ts](../../app/src/app/widgets/widget-registry.ts) resolving `"kalshi"` without rendering an unsupported-widget error. Note that [widget-gallery.test.tsx](../../app/src/app/widgets/__tests__/widget-gallery.test.tsx) asserts the exact list of built-in widget titles.
6. **ESLint architectural boundaries**
   - `app/src/features/kalshi/*` must **never** import from `@openchart/app/app/*` or `@openchart/server` runtime modules (only `@openchart/server/contract` types via `transport.ts`).
   - `server/index.ts` is the only root router composition point; never import `app` or `platform` from `server/kalshi/*`.
   - Every `.ts`/`.tsx` file requires a `// Purpose: ...` header comment and `@example` in JSDoc on exports; avoid `!` non-null assertions and unawaited promises (`void ...`).
7. **Windows verification & packaging gotchas**
   - **App ESLint hangs on Windows** (same root cause as `app/tooling/eslint.test.cjs` hanging indefinitely on Windows). Always run server ESLint (`npx eslint --max-warnings 0 server/kalshi/*.ts server/index.ts` with `NODE_OPTIONS=--max-old-space-size=6144`), full workspace `npm run typecheck`, `npx prettier --check`, and targeted Vitest suites instead.
   - **Pre-existing unrelated test failures on Windows:** `server/models/models.test.ts` and `server/models/onboarding/installation.test.ts` fail independently on Windows; run Kalshi tests directly rather than full `npm test` without filtering.
   - **Windows EXE file lock before packaging:** Before running `npm --prefix platform/desktop run package`, stop any running process matching `platform/desktop/out/0.1.25/OpenChart-win32-x64/OpenChart.exe`, or packaging fails with a file lock error.
   - **Installed vs source directories:** Do not edit `C:\Users\crucial\AppData\Local\OpenChart\app-0.1.21` (separate prebuilt copy); all source changes belong in `C:\Users\crucial\Projects\oc`.
   - **`openPosition` single-rule assumption:** `BracketMonitor` holds **one** active `KalshiBracketRule` at a time (matching Kalshi's one active 15-minute `KXBTC15M` market model). Expanding to multi-market or concurrent-contract trading later requires changing `activeRule` to a `Map<string, KalshiBracketRule>`.

---

## 7. Quick Verification & Rebuild Commands

Run from `C:\Users\crucial\Projects\oc`:

```powershell
# Server unit tests (client, router, bracket monitor)
npm run test:core -- server/kalshi/client.test.ts server/kalshi/router.test.ts server/kalshi/bracket-monitor.test.ts

# Server ESLint (run with 6GB heap from repo root)
$env:NODE_OPTIONS="--max-old-space-size=6144"
npx eslint --max-warnings 0 server/kalshi/*.ts server/index.ts

# App unit tests (feature panel + side drawer + gallery)
Set-Location app
npx vitest run src/features/kalshi src/app/kalshi src/app/widgets/__tests__/widget-gallery.test.tsx
Set-Location ..

# Types, DB migration drift, and formatting
npm run typecheck
npm run db:check
npx prettier --check "server/kalshi/*.ts" "app/src/features/kalshi/**/*.{ts,tsx}" "app/src/app/kalshi/**/*.{ts,tsx}" "app/src/app/{layout,page-header}.tsx" "app/src/app/widgets/widget-registry.ts" "docs/architecture/kalshi.md"

# Rebuild Windows OpenChart.exe (stop running build-folder OpenChart.exe first)
Get-Process -Name "*OpenChart*" -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -eq "C:\Users\crucial\Projects\oc\platform\desktop\out\0.1.25\OpenChart-win32-x64\OpenChart.exe" } |
  Stop-Process -Force
npm --prefix platform/desktop run package
```

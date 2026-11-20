# kalshi

Owns live production Kalshi `KXBTC15M` market reads, encrypted credential storage, V2 order execution, and server-side TP/SL bracket monitoring. See [Kalshi architecture](../../docs/architecture/kalshi.md).

- `client.ts` targets production `https://external-api.kalshi.com/trade-api/v2` directly; orders always hit `POST /portfolio/events/orders` (never deprecated `/portfolio/orders`, which returns `410 Gone`). Signs `${timestampMs}${METHOD}${pathWithoutQuery}` with RSA-PSS SHA-256 or Ed25519.
- Single-book YES-leg translation converts `buy_yes`/`buy_no` (`reduce_only: false`) and `sell_yes`/`sell_no` (`reduce_only: true`); `average_fill_price` on NO trades must be inverted (`1 - price`). Closing sells intentionally bypass `maxOrderDollars` so open positions are never trapped.
- `credentials.ts` persists encrypted keys via `Credential.Service` under synthetic `Integration.IntegrationID.make("kalshi")`; never expose `privateKeyPem` or full `apiKeyId` over tRPC or logs.
- `bracket-monitor.ts` holds at most one active `KalshiBracketRule` in memory (no DB persistence; cleared on restart, full fill, empty snapshot position, `15m` rollover, or `disconnect`), polling every `1s` while armed and applying a `2¢` stop-loss sweep buffer.
- `router.ts` uses `Schema.Literals([...])` (required in Effect v4), caches `fetchBalance` for `10s`, and returns `{ ok: true, ... } | { ok: false, error }` from mutations so user-facing errors bypass `server/lib/trpc/errors.ts` 500 scrubbing.

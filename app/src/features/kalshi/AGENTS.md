# kalshi feature

Owns `KalshiTradePanel` (`components/kalshi-trade-panel.tsx`) and the built-in `kalshiWidget` dashboard adapter (`components/widget.tsx`). See [Kalshi architecture](../../../../docs/architecture/kalshi.md).

- `KalshiTradePanel` accepts optional `{ transport, visible, onClose }` and falls back to `WidgetContext`, so it works both inside `app/kalshi/KalshiSidePanel` and as a dashboard widget. Never import from `@openchart/app/app/*` or `@openchart/server` runtime modules.
- Polls `transport.rpc.kalshi.snapshot` every `1000ms` only while `visible` is true (`enabled: visible`); keeps the countdown ticker aligned to `market.closeTime`.
- Buy YES, Buy NO, and Sell submit immediately in 1 click without confirmation popups (gated only by `isPending`, balance/cap checks, and live connection). `Dollars ($)` sizing floors whole contracts (`Math.floor((amount + 1e-9) / ask)`); sub-cent quotes render to 1 decimal place (`1.9¢`).
- Pre-buy `Auto TP (+¢)` / `Auto SL (-¢)` offsets pass through `placeOrder`; Open Position syncs `tpCentsDraft` / `slCentsDraft` strictly on primitive bracket identity/timestamp keys so `1s` polling never overwrites edits.

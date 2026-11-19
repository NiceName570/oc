// Purpose: Sign, query, and submit Kalshi BTC 15-minute market, position, and V2 order requests.

import crypto from "node:crypto";

/** Base origin for live production Kalshi Trade API v2 requests. */
export const KALSHI_API_ORIGIN = "https://external-api.kalshi.com";

/** Base URL prefix for live production Kalshi Trade API v2 endpoints. */
export const KALSHI_API_BASE = `${KALSHI_API_ORIGIN}/trade-api/v2`;

/** Kalshi series ticker for 15-minute Bitcoin up/down binary contracts. */
export const KALSHI_BTC15M_SERIES = "KXBTC15M";

/** Public Coinbase spot price endpoint used to compare live BTC against strike. */
export const COINBASE_BTC_SPOT_URL =
  "https://api.coinbase.com/v2/prices/BTC-USD/spot";

/** Signing algorithms supported by Kalshi API key credentials. */
export type KalshiKeyAlgorithm = "rsa-pss" | "ed25519";

/** Decrypted Kalshi API key material held strictly on the server. */
export interface KalshiCredentials {
  readonly apiKeyId: string;
  readonly privateKeyPem: string;
}

/** Normalized active 15-minute BTC market quote returned by Kalshi. */
export interface KalshiBtc15mMarket {
  readonly ticker: string;
  readonly eventTicker: string;
  readonly title: string;
  readonly strikeDollars: number | null;
  readonly openTime: string;
  readonly closeTime: string;
  readonly exchangeIndex: number;
  readonly yesBidDollars: number | null;
  readonly yesAskDollars: number | null;
  readonly noBidDollars: number | null;
  readonly noAskDollars: number | null;
  readonly lastPriceDollars: number | null;
}

/** Open Kalshi position summary for a specific BTC 15-minute contract. */
export interface KalshiMarketPosition {
  readonly ticker: string;
  readonly side: "yes" | "no";
  readonly contracts: number;
  readonly costBasisDollars: number;
  readonly realizedPnlDollars: number;
  readonly feesPaidDollars: number;
}

/** Live mark-to-bid liquidation proceeds and unrealized P&L estimate. */
export interface KalshiPositionPnl {
  readonly exitBidDollars: number | null;
  readonly exitProceedsDollars: number | null;
  readonly estimatedPnlDollars: number | null;
}

/** User-facing trade actions mapped onto Kalshi's single-book YES leg. */
export type KalshiOrderAction = "buy_yes" | "buy_no" | "sell_yes" | "sell_no";

/** Request body accepted by Kalshi `POST /trade-api/v2/portfolio/events/orders`. */
export interface KalshiOrderV2Payload {
  readonly ticker: string;
  readonly side: "bid" | "ask";
  readonly count: string;
  readonly price: string;
  readonly time_in_force: "immediate_or_cancel";
  readonly self_trade_prevention_type: "taker_at_cross";
  readonly client_order_id: string;
  readonly reduce_only: boolean;
  readonly exchange_index?: number;
}

/** Normalized execution summary returned by Kalshi Order V2. */
export interface KalshiOrderResult {
  readonly orderId: string;
  readonly clientOrderId: string;
  readonly fillCount: string;
  readonly remainingCount: string;
  readonly averageFillPrice: number | null;
  readonly averageFeePaid: number | null;
  readonly timestampMs: number;
}

/** Account cash and portfolio value returned by Kalshi. */
export interface KalshiBalanceSnapshot {
  readonly balanceDollars: number;
  readonly portfolioValueDollars: number;
  readonly updatedAt: number;
}

/** Structured error thrown when a Kalshi or market-data HTTP call fails. */
export class KalshiApiError extends Error {
  readonly status: number;
  readonly code?: string;

  /** Construct an HTTP error without leaking signing headers or key material. @example new KalshiApiError("Unauthorized", 401, "unauthorized") */
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "KalshiApiError";
    this.status = status;
    this.code = code;
  }
}

interface RawKalshiMarket {
  readonly ticker?: unknown;
  readonly event_ticker?: unknown;
  readonly title?: unknown;
  readonly floor_strike?: unknown;
  readonly open_time?: unknown;
  readonly close_time?: unknown;
  readonly exchange_index?: unknown;
  readonly status?: unknown;
  readonly yes_bid_dollars?: unknown;
  readonly yes_ask_dollars?: unknown;
  readonly no_bid_dollars?: unknown;
  readonly no_ask_dollars?: unknown;
  readonly last_price_dollars?: unknown;
  readonly yes_bid?: unknown;
  readonly yes_ask?: unknown;
  readonly no_bid?: unknown;
  readonly no_ask?: unknown;
  readonly last_price?: unknown;
}

interface RawKalshiPosition {
  readonly ticker?: unknown;
  readonly position_fp?: unknown;
  readonly position?: unknown;
  readonly market_exposure_dollars?: unknown;
  readonly realized_pnl_dollars?: unknown;
  readonly fees_paid_dollars?: unknown;
}

interface RawKalshiErrorBody {
  readonly error?: {
    readonly code?: unknown;
    readonly message?: unknown;
  };
  readonly code?: unknown;
  readonly message?: unknown;
}

function normalizePrivateKeyPem(raw: string): string {
  return raw.replaceAll("\r\n", "\n").replaceAll("\\n", "\n").trim();
}

function parseOptionalNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parsePriceFallback(
  dollarsValue: unknown,
  centsValue: unknown,
): number | null {
  const dollars = parseOptionalNumber(dollarsValue);
  if (dollars !== null) return dollars;
  const cents = parseOptionalNumber(centsValue);
  return cents !== null ? cents / 100 : null;
}

function extractErrorDetails(body: unknown): {
  message?: string;
  code?: string;
} {
  if (!body || typeof body !== "object") return {};
  const record = body as RawKalshiErrorBody;
  const nestedMessage =
    typeof record.error?.message === "string"
      ? record.error.message
      : undefined;
  const nestedCode =
    typeof record.error?.code === "string" ? record.error.code : undefined;
  const topMessage =
    typeof record.message === "string" ? record.message : undefined;
  const topCode = typeof record.code === "string" ? record.code : undefined;
  return {
    message: nestedMessage ?? topMessage,
    code: nestedCode ?? topCode,
  };
}

/** Validate a pasted RSA or Ed25519 PEM private key without retaining plaintext outside the caller. @example validateKalshiPrivateKey(pem) */
export function validateKalshiPrivateKey(rawPem: string): {
  readonly pem: string;
  readonly algorithm: KalshiKeyAlgorithm;
} {
  const pem = normalizePrivateKeyPem(rawPem);
  if (pem.length === 0) {
    throw new Error("Kalshi private key PEM is required.");
  }
  const key = crypto.createPrivateKey(pem);
  if (key.asymmetricKeyType === "rsa" || key.asymmetricKeyType === "rsa-pss") {
    return { pem, algorithm: "rsa-pss" };
  }
  if (key.asymmetricKeyType === "ed25519") {
    return { pem, algorithm: "ed25519" };
  }
  throw new Error(
    `Unsupported Kalshi private key type (${key.asymmetricKeyType ?? "unknown"}); expected RSA or Ed25519 PEM.`,
  );
}

/** Sign `${timestampMs}${METHOD}${pathWithoutQuery}` for `KALSHI-ACCESS-SIGNATURE`. @example signKalshiRequest({ privateKeyPem, timestampMs: "1700000000000", method: "GET", path: "/trade-api/v2/portfolio/balance" }) */
export function signKalshiRequest(input: {
  readonly privateKeyPem: string;
  readonly timestampMs: string;
  readonly method: string;
  readonly path: string;
}): string {
  const { pem, algorithm } = validateKalshiPrivateKey(input.privateKeyPem);
  const key = crypto.createPrivateKey(pem);
  const rawPath = input.path.split("?")[0] ?? "/";
  const pathWithoutQuery = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  const message = `${input.timestampMs}${input.method.toUpperCase()}${pathWithoutQuery}`;
  const buffer = Buffer.from(message, "utf8");

  if (algorithm === "ed25519") {
    return crypto.sign(null, buffer, key).toString("base64");
  }
  return crypto
    .sign("sha256", buffer, {
      key,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    })
    .toString("base64");
}

/** Reject buy orders whose cost exceeds `maxOrderDollars`, leaving closing sells unblocked. @example assertBuyWithinCap({ action: "buy_yes", count: 5, limitPriceDollars: 0.6, maxOrderDollars: 10 }) */
export function assertBuyWithinCap(input: {
  readonly action: KalshiOrderAction;
  readonly count: number;
  readonly limitPriceDollars: number;
  readonly maxOrderDollars: number;
}): number {
  const estimatedCostDollars = Number(
    (input.count * input.limitPriceDollars).toFixed(4),
  );
  if (input.action === "buy_yes" || input.action === "buy_no") {
    if (
      !(input.maxOrderDollars > 0) ||
      !Number.isFinite(input.maxOrderDollars)
    ) {
      throw new Error("Max order cap must be a positive dollar amount.");
    }
    if (estimatedCostDollars > input.maxOrderDollars + 1e-9) {
      throw new Error(
        `Order cost $${estimatedCostDollars.toFixed(2)} exceeds max order cap of $${input.maxOrderDollars.toFixed(2)}.`,
      );
    }
  }
  return estimatedCostDollars;
}

/** Map a user YES/NO buy or sell action onto Kalshi's single-book YES-leg V2 order payload. @example buildOrderV2Payload({ ticker: "KXBTC15M-TEST", action: "buy_no", count: 5, limitPriceDollars: 0.35 }) */
export function buildOrderV2Payload(input: {
  readonly ticker: string;
  readonly action: KalshiOrderAction;
  readonly count: number;
  readonly limitPriceDollars: number;
  readonly clientOrderId?: string;
  readonly exchangeIndex?: number;
}): KalshiOrderV2Payload {
  if (!Number.isFinite(input.count) || input.count <= 0) {
    throw new Error("Order contract count must be greater than zero.");
  }
  if (
    !Number.isFinite(input.limitPriceDollars) ||
    input.limitPriceDollars < 0.01 ||
    input.limitPriceDollars > 0.99
  ) {
    throw new Error("Contract price must be between $0.01 and $0.99.");
  }

  let side: "bid" | "ask";
  let yesLegPrice: number;
  let reduceOnly: boolean;

  switch (input.action) {
    case "buy_yes":
      side = "bid";
      yesLegPrice = input.limitPriceDollars;
      reduceOnly = false;
      break;
    case "buy_no":
      side = "ask";
      yesLegPrice = 1 - input.limitPriceDollars;
      reduceOnly = false;
      break;
    case "sell_yes":
      side = "ask";
      yesLegPrice = input.limitPriceDollars;
      reduceOnly = true;
      break;
    case "sell_no":
      side = "bid";
      yesLegPrice = 1 - input.limitPriceDollars;
      reduceOnly = true;
      break;
  }

  const normalizedPrice = Number(yesLegPrice.toFixed(4));
  if (normalizedPrice < 0.01 || normalizedPrice > 0.99) {
    throw new Error(
      "Converted YES-leg order price must stay within $0.01-$0.99.",
    );
  }

  return {
    ticker: input.ticker,
    side,
    count: input.count.toFixed(2),
    price: normalizedPrice.toFixed(4),
    time_in_force: "immediate_or_cancel",
    self_trade_prevention_type: "taker_at_cross",
    client_order_id: input.clientOrderId ?? crypto.randomUUID(),
    reduce_only: reduceOnly,
    ...(input.exchangeIndex !== undefined
      ? { exchange_index: input.exchangeIndex }
      : {}),
  };
}

/** Estimate instant exit proceeds and unrealized P&L against the active market exit bid. @example computePositionPnl({ position, market }) */
export function computePositionPnl(input: {
  readonly position: KalshiMarketPosition;
  readonly market: Pick<KalshiBtc15mMarket, "yesBidDollars" | "noBidDollars">;
}): KalshiPositionPnl {
  const exitBidDollars =
    input.position.side === "yes"
      ? input.market.yesBidDollars
      : input.market.noBidDollars;
  if (exitBidDollars === null) {
    return {
      exitBidDollars: null,
      exitProceedsDollars: null,
      estimatedPnlDollars: null,
    };
  }
  const exitProceedsDollars = Number(
    (input.position.contracts * exitBidDollars).toFixed(4),
  );
  const estimatedPnlDollars = Number(
    (exitProceedsDollars - input.position.costBasisDollars).toFixed(4),
  );
  return {
    exitBidDollars,
    exitProceedsDollars,
    estimatedPnlDollars,
  };
}

/** Fetch the currently active Kalshi `KXBTC15M` market with the soonest future close time. @example await fetchActiveBtc15mMarket() */
export async function fetchActiveBtc15mMarket(options?: {
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly nowMs?: number;
}): Promise<KalshiBtc15mMarket | null> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const nowMs = options?.nowMs ?? Date.now();
  const url = `${KALSHI_API_BASE}/markets?series_ticker=${KALSHI_BTC15M_SERIES}&status=open&limit=5`;
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: options?.signal,
  });

  if (!response.ok) {
    throw new KalshiApiError(
      `Kalshi market query failed (${response.status})`,
      response.status,
    );
  }

  const body = (await response.json()) as {
    readonly markets?: readonly RawKalshiMarket[];
  };
  const candidates = (body.markets ?? [])
    .filter((market) => {
      if (
        typeof market.ticker !== "string" ||
        typeof market.close_time !== "string"
      ) {
        return false;
      }
      const status = typeof market.status === "string" ? market.status : "";
      if (status !== "" && status !== "active" && status !== "open") {
        return false;
      }
      const closeMs = Date.parse(market.close_time);
      return Number.isFinite(closeMs) && closeMs > nowMs;
    })
    .sort(
      (a, b) =>
        Date.parse(String(a.close_time)) - Date.parse(String(b.close_time)),
    );

  const current = candidates[0];
  if (!current || typeof current.ticker !== "string") return null;

  return {
    ticker: current.ticker,
    eventTicker:
      typeof current.event_ticker === "string" ? current.event_ticker : "",
    title: typeof current.title === "string" ? current.title : current.ticker,
    strikeDollars: parseOptionalNumber(current.floor_strike),
    openTime: typeof current.open_time === "string" ? current.open_time : "",
    closeTime: typeof current.close_time === "string" ? current.close_time : "",
    exchangeIndex:
      typeof current.exchange_index === "number" ? current.exchange_index : 2,
    yesBidDollars: parsePriceFallback(current.yes_bid_dollars, current.yes_bid),
    yesAskDollars: parsePriceFallback(current.yes_ask_dollars, current.yes_ask),
    noBidDollars: parsePriceFallback(current.no_bid_dollars, current.no_bid),
    noAskDollars: parsePriceFallback(current.no_ask_dollars, current.no_ask),
    lastPriceDollars: parsePriceFallback(
      current.last_price_dollars,
      current.last_price,
    ),
  };
}

/** Fetch live Coinbase BTC-USD spot price in dollars. @example await fetchBtcSpotUsd() */
export async function fetchBtcSpotUsd(options?: {
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
}): Promise<number> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const response = await fetchImpl(COINBASE_BTC_SPOT_URL, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: options?.signal,
  });

  if (!response.ok) {
    throw new KalshiApiError(
      `Coinbase BTC spot request failed (${response.status})`,
      response.status,
    );
  }

  const body = (await response.json()) as {
    readonly data?: { readonly amount?: unknown };
  };
  const spot = parseOptionalNumber(body.data?.amount);
  if (spot === null || spot <= 0) {
    throw new KalshiApiError(
      "Coinbase returned an invalid BTC spot price.",
      502,
    );
  }
  return spot;
}

async function kalshiSignedFetch<T>(input: {
  readonly credentials: KalshiCredentials;
  readonly method: "GET" | "POST" | "DELETE";
  readonly pathAndQuery: string;
  readonly body?: unknown;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly nowMs?: number;
}): Promise<T> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const normalizedPath = input.pathAndQuery.startsWith("/")
    ? input.pathAndQuery
    : `/${input.pathAndQuery}`;
  const timestampMs = String(input.nowMs ?? Date.now());
  const signature = signKalshiRequest({
    privateKeyPem: input.credentials.privateKeyPem,
    timestampMs,
    method: input.method,
    path: normalizedPath,
  });

  const headers: Record<string, string> = {
    Accept: "application/json",
    "KALSHI-ACCESS-KEY": input.credentials.apiKeyId,
    "KALSHI-ACCESS-TIMESTAMP": timestampMs,
    "KALSHI-ACCESS-SIGNATURE": signature,
  };
  if (input.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetchImpl(`${KALSHI_API_ORIGIN}${normalizedPath}`, {
    method: input.method,
    headers,
    ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
    signal: input.signal,
  });

  let parsed: unknown = undefined;
  try {
    parsed = await response.json();
  } catch {
    parsed = undefined;
  }

  if (!response.ok) {
    const details = extractErrorDetails(parsed);
    throw new KalshiApiError(
      details.message ?? `Kalshi request failed (${response.status})`,
      response.status,
      details.code,
    );
  }

  return parsed as T;
}

/** Fetch the authenticated Kalshi cash balance and portfolio value. @example await fetchBalance({ credentials }) */
export async function fetchBalance(input: {
  readonly credentials: KalshiCredentials;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly nowMs?: number;
}): Promise<KalshiBalanceSnapshot> {
  const raw = await kalshiSignedFetch<{
    readonly balance?: unknown;
    readonly balance_dollars?: unknown;
    readonly portfolio_value?: unknown;
    readonly portfolio_value_dollars?: unknown;
    readonly updated_ts?: unknown;
  }>({
    credentials: input.credentials,
    method: "GET",
    pathAndQuery: "/trade-api/v2/portfolio/balance",
    fetchImpl: input.fetchImpl,
    signal: input.signal,
    nowMs: input.nowMs,
  });

  const balanceDollars =
    parsePriceFallback(raw.balance_dollars, raw.balance) ?? 0;
  const portfolioValueDollars =
    parsePriceFallback(raw.portfolio_value_dollars, raw.portfolio_value) ?? 0;
  const updatedAt = parseOptionalNumber(raw.updated_ts) ?? Date.now();

  return {
    balanceDollars,
    portfolioValueDollars,
    updatedAt,
  };
}

/** Fetch the current open position for a specific `KXBTC15M` market ticker, if any. @example await fetchMarketPosition({ credentials, ticker }) */
export async function fetchMarketPosition(input: {
  readonly credentials: KalshiCredentials;
  readonly ticker: string;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly nowMs?: number;
}): Promise<KalshiMarketPosition | null> {
  const query = new URLSearchParams({
    ticker: input.ticker,
    count_filter: "position",
  });
  const raw = await kalshiSignedFetch<{
    readonly market_positions?: readonly RawKalshiPosition[];
  }>({
    credentials: input.credentials,
    method: "GET",
    pathAndQuery: `/trade-api/v2/portfolio/positions?${query.toString()}`,
    fetchImpl: input.fetchImpl,
    signal: input.signal,
    nowMs: input.nowMs,
  });

  const match = (raw.market_positions ?? []).find(
    (entry) => entry.ticker === input.ticker,
  );
  if (!match) return null;

  const signedContracts =
    parseOptionalNumber(match.position_fp) ??
    parseOptionalNumber(match.position) ??
    0;
  if (Math.abs(signedContracts) < 1e-6) return null;

  return {
    ticker: input.ticker,
    side: signedContracts > 0 ? "yes" : "no",
    contracts: Math.abs(signedContracts),
    costBasisDollars: parseOptionalNumber(match.market_exposure_dollars) ?? 0,
    realizedPnlDollars: parseOptionalNumber(match.realized_pnl_dollars) ?? 0,
    feesPaidDollars: parseOptionalNumber(match.fees_paid_dollars) ?? 0,
  };
}

/** Submit an immediate-or-cancel V2 order to `/trade-api/v2/portfolio/events/orders` after enforcing `maxOrderDollars`. @example await createOrderV2({ credentials, ticker, action: "buy_yes", count: 2, limitPriceDollars: 0.55, maxOrderDollars: 25 }) */
export async function createOrderV2(input: {
  readonly credentials: KalshiCredentials;
  readonly ticker: string;
  readonly action: KalshiOrderAction;
  readonly count: number;
  readonly limitPriceDollars: number;
  readonly maxOrderDollars: number;
  readonly exchangeIndex?: number;
  readonly clientOrderId?: string;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly nowMs?: number;
}): Promise<KalshiOrderResult> {
  assertBuyWithinCap({
    action: input.action,
    count: input.count,
    limitPriceDollars: input.limitPriceDollars,
    maxOrderDollars: input.maxOrderDollars,
  });

  const payload = buildOrderV2Payload({
    ticker: input.ticker,
    action: input.action,
    count: input.count,
    limitPriceDollars: input.limitPriceDollars,
    clientOrderId: input.clientOrderId,
    exchangeIndex: input.exchangeIndex,
  });

  const raw = await kalshiSignedFetch<{
    readonly order_id?: unknown;
    readonly client_order_id?: unknown;
    readonly fill_count?: unknown;
    readonly remaining_count?: unknown;
    readonly average_fill_price?: unknown;
    readonly average_fee_paid?: unknown;
    readonly ts_ms?: unknown;
  }>({
    credentials: input.credentials,
    method: "POST",
    pathAndQuery: "/trade-api/v2/portfolio/events/orders",
    body: payload,
    fetchImpl: input.fetchImpl,
    signal: input.signal,
    nowMs: input.nowMs,
  });

  return {
    orderId: typeof raw.order_id === "string" ? raw.order_id : "",
    clientOrderId:
      typeof raw.client_order_id === "string"
        ? raw.client_order_id
        : payload.client_order_id,
    fillCount:
      typeof raw.fill_count === "string"
        ? raw.fill_count
        : String(raw.fill_count ?? "0"),
    remainingCount:
      typeof raw.remaining_count === "string"
        ? raw.remaining_count
        : String(raw.remaining_count ?? "0"),
    averageFillPrice: parseOptionalNumber(raw.average_fill_price),
    averageFeePaid: parseOptionalNumber(raw.average_fee_paid),
    timestampMs: parseOptionalNumber(raw.ts_ms) ?? Date.now(),
  };
}

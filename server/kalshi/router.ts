// Purpose: Expose encrypted Kalshi credential management, live BTC 15m market snapshot, and V2 order submission over tRPC.

import { trpc } from "@openchart/server/lib/trpc";
import { Schema } from "effect";

import {
  computeAutoBracketTargets,
  createBracketMonitor,
  type KalshiBracketEvent,
  type KalshiBracketRule,
} from "./bracket-monitor";
import {
  createOrderV2,
  fetchActiveBtc15mMarket,
  fetchBalance,
  fetchBtcSpotUsd,
  fetchMarketPosition,
  KalshiApiError,
  validateKalshiPrivateKey,
  computePositionPnl,
  type KalshiBalanceSnapshot,
  type KalshiBtc15mMarket,
  type KalshiMarketPosition,
  type KalshiOrderResult,
  type KalshiPositionPnl,
} from "./client";
import {
  clearKalshiCredentials,
  DEFAULT_MAX_ORDER_DOLLARS,
  maskApiKeyId,
  readKalshiCredentials,
  saveKalshiCredentials,
  updateKalshiMaxOrderDollars,
} from "./credentials";

const BALANCE_CACHE_TTL_MS = 10_000;
const parseOptions = { onExcessProperty: "error" } as const;

const connectInput = Schema.Struct({
  apiKeyId: Schema.String,
  privateKeyPem: Schema.String,
  maxOrderDollars: Schema.Number,
});

const maxOrderInput = Schema.Struct({
  maxOrderDollars: Schema.Number,
});

const orderActionSchema = Schema.Literals([
  "buy_yes",
  "buy_no",
  "sell_yes",
  "sell_no",
]);

const placeOrderInput = Schema.Struct({
  ticker: Schema.String,
  action: orderActionSchema,
  count: Schema.Number,
  limitPriceDollars: Schema.Number,
  exchangeIndex: Schema.optional(Schema.Number),
  takeProfitOffsetCents: Schema.optional(Schema.Number),
  stopLossOffsetCents: Schema.optional(Schema.Number),
});

const bracketSideSchema = Schema.Literals(["yes", "no"]);

const setBracketInput = Schema.Struct({
  ticker: Schema.String,
  side: bracketSideSchema,
  takeProfitDollars: Schema.Union([Schema.Number, Schema.Null]),
  stopLossDollars: Schema.Union([Schema.Number, Schema.Null]),
  exchangeIndex: Schema.optional(Schema.Number),
});

const clearBracketInput = Schema.Struct({
  ticker: Schema.optional(Schema.String),
});

/** Public snapshot returned to the Kalshi widget without exposing secrets. */
export interface KalshiSnapshot {
  readonly connected: boolean;
  readonly maskedApiKeyId: string | null;
  readonly maxOrderDollars: number;
  readonly market: KalshiBtc15mMarket | null;
  readonly spotUsd: number | null;
  readonly distanceDollars: number | null;
  readonly distancePercent: number | null;
  readonly balance: KalshiBalanceSnapshot | null;
  readonly position: (KalshiMarketPosition & KalshiPositionPnl) | null;
  readonly bracket: KalshiBracketRule | null;
  readonly lastBracketEvent: KalshiBracketEvent | null;
  readonly marketError: string | null;
  readonly accountError: string | null;
  readonly updatedAt: number;
}

/** Options to customize HTTP transport and cache timings in tests. */
export interface KalshiRouterOptions {
  readonly fetchImpl?: typeof fetch;
  readonly balanceCacheTtlMs?: number;
  readonly bracketPollIntervalMs?: number;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof KalshiApiError) {
    return error.code ? `${error.message} (${error.code})` : error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "Unexpected Kalshi error.";
}

/** Create the Kalshi tRPC router with isolated 10s balance caching and optional test `fetchImpl`. @example const router = createKalshiRouter(); */
export function createKalshiRouter(options?: KalshiRouterOptions) {
  const fetchImpl = options?.fetchImpl;
  const balanceCacheTtlMs = options?.balanceCacheTtlMs ?? BALANCE_CACHE_TTL_MS;

  let cachedBalance:
    | {
        readonly apiKeyId: string;
        readonly fetchedAtMs: number;
        readonly snapshot: KalshiBalanceSnapshot;
      }
    | undefined;

  const invalidateBalanceCache = () => {
    cachedBalance = undefined;
  };

  const bracketMonitor = createBracketMonitor({
    fetchImpl,
    pollIntervalMs: options?.bracketPollIntervalMs,
    onOrderExecuted: invalidateBalanceCache,
  });

  return trpc.router({
    status: trpc.procedure.query(async ({ ctx }) => {
      const stored = await ctx.runtime.runPromise(readKalshiCredentials);
      if (!stored) {
        return {
          connected: false,
          maskedApiKeyId: null,
          maxOrderDollars: DEFAULT_MAX_ORDER_DOLLARS,
        };
      }
      return {
        connected: true,
        maskedApiKeyId: maskApiKeyId(stored.apiKeyId),
        maxOrderDollars: stored.maxOrderDollars,
      };
    }),

    connect: trpc.procedure
      .input(Schema.toStandardSchemaV1(connectInput, { parseOptions }))
      .mutation(async ({ ctx, input }) => {
        const apiKeyId = input.apiKeyId.trim();
        if (apiKeyId.length === 0) {
          return {
            ok: false as const,
            error: "Kalshi API Key ID is required.",
          };
        }
        if (
          !Number.isFinite(input.maxOrderDollars) ||
          input.maxOrderDollars <= 0
        ) {
          return {
            ok: false as const,
            error: "Max order cap must be a positive dollar amount.",
          };
        }

        try {
          const { pem, algorithm } = validateKalshiPrivateKey(
            input.privateKeyPem,
          );
          const balance = await fetchBalance({
            credentials: { apiKeyId, privateKeyPem: pem },
            fetchImpl,
          });
          const summary = await ctx.runtime.runPromise(
            saveKalshiCredentials({
              apiKeyId,
              privateKeyPem: pem,
              maxOrderDollars: input.maxOrderDollars,
            }),
          );
          cachedBalance = {
            apiKeyId,
            fetchedAtMs: Date.now(),
            snapshot: balance,
          };
          return {
            ok: true as const,
            maskedApiKeyId: summary.maskedApiKeyId,
            maxOrderDollars: summary.maxOrderDollars,
            algorithm,
            balance,
          };
        } catch (error) {
          return {
            ok: false as const,
            error: safeErrorMessage(error),
          };
        }
      }),

    disconnect: trpc.procedure.mutation(async ({ ctx }) => {
      bracketMonitor.clearAll();
      invalidateBalanceCache();
      await ctx.runtime.runPromise(clearKalshiCredentials);
      return { ok: true as const };
    }),

    setMaxOrderDollars: trpc.procedure
      .input(Schema.toStandardSchemaV1(maxOrderInput, { parseOptions }))
      .mutation(async ({ ctx, input }) => {
        if (
          !Number.isFinite(input.maxOrderDollars) ||
          input.maxOrderDollars <= 0
        ) {
          return {
            ok: false as const,
            error: "Max order cap must be a positive dollar amount.",
          };
        }

        try {
          const updated = await ctx.runtime.runPromise(
            updateKalshiMaxOrderDollars(input.maxOrderDollars),
          );
          if (!updated) {
            return {
              ok: false as const,
              error: "Connect your Kalshi API credentials first.",
            };
          }
          return {
            ok: true as const,
            maskedApiKeyId: updated.maskedApiKeyId,
            maxOrderDollars: updated.maxOrderDollars,
          };
        } catch (error) {
          return {
            ok: false as const,
            error: safeErrorMessage(error),
          };
        }
      }),

    snapshot: trpc.procedure.query(async ({ ctx }): Promise<KalshiSnapshot> => {
      const stored = await ctx.runtime.runPromise(readKalshiCredentials);
      const [marketResult, spotResult] = await Promise.allSettled([
        fetchActiveBtc15mMarket({ fetchImpl }),
        fetchBtcSpotUsd({ fetchImpl }),
      ]);

      const market =
        marketResult.status === "fulfilled" ? marketResult.value : null;
      const spotUsd =
        spotResult.status === "fulfilled" ? spotResult.value : null;

      const marketErrors: string[] = [];
      if (marketResult.status === "rejected") {
        marketErrors.push(safeErrorMessage(marketResult.reason));
      }
      if (spotResult.status === "rejected") {
        marketErrors.push(safeErrorMessage(spotResult.reason));
      }

      const distanceDollars =
        spotUsd !== null && market?.strikeDollars != null
          ? Number((spotUsd - market.strikeDollars).toFixed(2))
          : null;
      const distancePercent =
        distanceDollars !== null &&
        market?.strikeDollars != null &&
        market.strikeDollars !== 0
          ? Number(((distanceDollars / market.strikeDollars) * 100).toFixed(4))
          : null;

      let balance: KalshiBalanceSnapshot | null = null;
      let position: (KalshiMarketPosition & KalshiPositionPnl) | null = null;
      let accountError: string | null = null;

      if (stored) {
        const now = Date.now();
        const activeCache =
          cachedBalance !== undefined &&
          cachedBalance.apiKeyId === stored.apiKeyId &&
          now - cachedBalance.fetchedAtMs < balanceCacheTtlMs
            ? cachedBalance
            : undefined;

        const balancePromise = activeCache
          ? Promise.resolve(activeCache.snapshot)
          : fetchBalance({ credentials: stored, fetchImpl });

        const positionPromise = market
          ? fetchMarketPosition({
              credentials: stored,
              ticker: market.ticker,
              fetchImpl,
            })
          : Promise.resolve(null);

        const [balanceResult, positionResult] = await Promise.allSettled([
          balancePromise,
          positionPromise,
        ]);

        const accountErrors: string[] = [];
        if (balanceResult.status === "fulfilled") {
          balance = balanceResult.value;
          if (!activeCache) {
            cachedBalance = {
              apiKeyId: stored.apiKeyId,
              fetchedAtMs: Date.now(),
              snapshot: balanceResult.value,
            };
          }
        } else {
          invalidateBalanceCache();
          accountErrors.push(safeErrorMessage(balanceResult.reason));
        }

        if (positionResult.status === "fulfilled") {
          const openPos = positionResult.value;
          if (openPos && market) {
            const pnl = computePositionPnl({ position: openPos, market });
            position = {
              ...openPos,
              ...pnl,
            };
          } else if (market) {
            bracketMonitor.clearRule(market.ticker);
          }
        } else {
          accountErrors.push(safeErrorMessage(positionResult.reason));
        }

        if (accountErrors.length > 0) {
          accountError = accountErrors.join(" • ");
        }
      }

      return {
        connected: stored !== null,
        maskedApiKeyId: stored ? maskApiKeyId(stored.apiKeyId) : null,
        maxOrderDollars: stored?.maxOrderDollars ?? DEFAULT_MAX_ORDER_DOLLARS,
        market,
        spotUsd,
        distanceDollars,
        distancePercent,
        balance,
        position,
        bracket: market ? bracketMonitor.getRule(market.ticker) : null,
        lastBracketEvent: bracketMonitor.getLastEvent(),
        marketError: marketErrors.length > 0 ? marketErrors.join(" • ") : null,
        accountError,
        updatedAt: Date.now(),
      };
    }),

    placeOrder: trpc.procedure
      .input(Schema.toStandardSchemaV1(placeOrderInput, { parseOptions }))
      .mutation(
        async ({
          ctx,
          input,
        }): Promise<
          | {
              readonly ok: true;
              readonly order: KalshiOrderResult;
              readonly bracket: KalshiBracketRule | null;
            }
          | { readonly ok: false; readonly error: string }
        > => {
          const stored = await ctx.runtime.runPromise(readKalshiCredentials);
          if (!stored) {
            return {
              ok: false,
              error: "Connect your Kalshi API credentials first.",
            };
          }

          const ticker = input.ticker.trim();
          try {
            const order = await createOrderV2({
              credentials: stored,
              ticker,
              action: input.action,
              count: input.count,
              limitPriceDollars: input.limitPriceDollars,
              maxOrderDollars: stored.maxOrderDollars,
              exchangeIndex: input.exchangeIndex,
              fetchImpl,
            });
            invalidateBalanceCache();

            const fillNum = Number(order.fillCount);
            const remainingNum = Number(order.remainingCount);
            if (
              (input.action === "buy_yes" || input.action === "buy_no") &&
              Number.isFinite(fillNum) &&
              fillNum > 0 &&
              ((input.takeProfitOffsetCents ?? 0) > 0 ||
                (input.stopLossOffsetCents ?? 0) > 0)
            ) {
              const side: "yes" | "no" =
                input.action === "buy_yes" ? "yes" : "no";
              const entryPriceDollars =
                order.averageFillPrice !== null
                  ? side === "no"
                    ? 1 - order.averageFillPrice
                    : order.averageFillPrice
                  : input.limitPriceDollars;
              const targets = computeAutoBracketTargets({
                entryPriceDollars,
                takeProfitOffsetCents: input.takeProfitOffsetCents,
                stopLossOffsetCents: input.stopLossOffsetCents,
              });
              if (
                targets.takeProfitDollars !== null ||
                targets.stopLossDollars !== null
              ) {
                bracketMonitor.setRule({
                  runtime: ctx.runtime,
                  ticker,
                  side,
                  takeProfitDollars: targets.takeProfitDollars,
                  stopLossDollars: targets.stopLossDollars,
                  exchangeIndex: input.exchangeIndex,
                });
              }
            } else if (
              (input.action === "sell_yes" || input.action === "sell_no") &&
              Number.isFinite(fillNum) &&
              fillNum > 0 &&
              (!Number.isFinite(remainingNum) || remainingNum <= 1e-6)
            ) {
              bracketMonitor.clearRule(ticker);
            }

            return { ok: true, order, bracket: bracketMonitor.getRule(ticker) };
          } catch (error) {
            return {
              ok: false,
              error: safeErrorMessage(error),
            };
          }
        },
      ),

    setBracket: trpc.procedure
      .input(Schema.toStandardSchemaV1(setBracketInput, { parseOptions }))
      .mutation(
        async ({
          ctx,
          input,
        }): Promise<
          | { readonly ok: true; readonly bracket: KalshiBracketRule | null }
          | { readonly ok: false; readonly error: string }
        > => {
          const stored = await ctx.runtime.runPromise(readKalshiCredentials);
          if (!stored) {
            return {
              ok: false,
              error: "Connect your Kalshi API credentials first.",
            };
          }
          try {
            const bracket = bracketMonitor.setRule({
              runtime: ctx.runtime,
              ticker: input.ticker.trim(),
              side: input.side,
              takeProfitDollars: input.takeProfitDollars,
              stopLossDollars: input.stopLossDollars,
              exchangeIndex: input.exchangeIndex,
            });
            return { ok: true, bracket };
          } catch (error) {
            return { ok: false, error: safeErrorMessage(error) };
          }
        },
      ),

    clearBracket: trpc.procedure
      .input(Schema.toStandardSchemaV1(clearBracketInput, { parseOptions }))
      .mutation(async ({ input }) => {
        bracketMonitor.clearRule(input.ticker?.trim());
        return { ok: true as const };
      }),
  });
}

/** Mounted production Kalshi tRPC router exposed under `router.kalshi`. */
export const kalshiRouter = createKalshiRouter();

// Purpose: Compact live trading widget and side panel for Kalshi 15-minute BTC contracts.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Settings, ShieldCheck, Unplug, XIcon } from "lucide-react";
import { useContext, useEffect, useState } from "react";

import { Badge } from "@openchart/app/components/ui/badge";
import { Button } from "@openchart/app/components/ui/button";
import { Input } from "@openchart/app/components/ui/input";
import { Textarea } from "@openchart/app/components/ui/textarea";
import type { AppTransport } from "@openchart/app/lib/transport/transport";
import { WidgetContext } from "@openchart/app/lib/widget/widget";
import { cn } from "@openchart/app/utils/cn";

type KalshiSnapshot = Awaited<
  ReturnType<AppTransport["rpc"]["kalshi"]["snapshot"]["query"]>
>;
type KalshiOrderAction = "buy_yes" | "buy_no" | "sell_yes" | "sell_no";

interface PendingOrder {
  readonly ticker: string;
  readonly action: KalshiOrderAction;
  readonly count: number;
  readonly limitPriceDollars: number;
  readonly exchangeIndex?: number;
  readonly sideLabel: string;
  readonly estimatedDollars: number;
}

interface OrderBanner {
  readonly tone: "success" | "error";
  readonly text: string;
}

const SNAPSHOT_QUERY_KEY = ["kalshi", "snapshot"] as const;
const CONTRACT_PRESETS = [1, 5, 10] as const;

function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatSignedUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  const abs = formatUsd(Math.abs(value));
  if (value > 0) return `+${abs}`;
  if (value < 0) return `-${abs}`;
  return abs;
}

function formatCents(priceDollars: number | null | undefined): string {
  if (
    priceDollars === null ||
    priceDollars === undefined ||
    !Number.isFinite(priceDollars)
  ) {
    return "—";
  }
  const cents = priceDollars * 100;
  return Math.abs(cents - Math.round(cents)) >= 0.05
    ? `${cents.toFixed(1)}¢`
    : `${Math.round(cents)}¢`;
}

function formatCountdown(
  closeTimeIso: string | undefined,
  nowMs: number,
): {
  readonly label: string;
  readonly urgent: boolean;
} {
  if (!closeTimeIso) {
    return { label: "--:--", urgent: false };
  }
  const closeMs = Date.parse(closeTimeIso);
  if (!Number.isFinite(closeMs)) {
    return { label: "--:--", urgent: false };
  }
  const remainingSec = Math.max(0, Math.floor((closeMs - nowMs) / 1000));
  const mins = Math.floor(remainingSec / 60);
  const secs = remainingSec % 60;
  return {
    label: `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`,
    urgent: remainingSec <= 120,
  };
}

/** Compact live trading panel for Kalshi `KXBTC15M` contracts with distance-to-strike readout, always-visible Buy YES/NO ticket, confirm-gated execution, live exit P&L sells, and inline credential setup. @example <KalshiTradePanel transport={transport} onClose={() => setOpen(false)} /> */
export function KalshiTradePanel({
  transport: propTransport,
  visible = true,
  onClose,
}: {
  readonly transport?: AppTransport;
  readonly visible?: boolean;
  readonly onClose?: () => void;
} = {}) {
  const widget = useContext(WidgetContext);
  const transport = propTransport ?? widget?.transport;
  if (!transport) {
    throw new Error(
      "KalshiTradePanel requires a transport prop or WidgetContext",
    );
  }

  const queryClient = useQueryClient();

  const [nowMs, setNowMs] = useState(() => Date.now());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [replacingKey, setReplacingKey] = useState(false);

  const [apiKeyIdDraft, setApiKeyIdDraft] = useState("");
  const [privateKeyDraft, setPrivateKeyDraft] = useState("");
  const [capDraft, setCapDraft] = useState("25");
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const [contractCountRaw, setContractCountRaw] = useState("1");
  const [pendingOrder, setPendingOrder] = useState<PendingOrder | null>(null);
  const [orderBanner, setOrderBanner] = useState<OrderBanner | null>(null);

  useEffect(() => {
    if (!visible) return;
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [visible]);

  const snapshotQuery = useQuery<KalshiSnapshot>({
    queryKey: SNAPSHOT_QUERY_KEY,
    queryFn: () => transport.rpc.kalshi.snapshot.query(),
    enabled: visible,
    refetchInterval: 1000,
    retry: false,
  });

  const snapshot = snapshotQuery.data;
  const connected = snapshot?.connected ?? false;
  const snapshotMaxOrderDollars = snapshot?.maxOrderDollars;
  const maxOrderDollars = snapshotMaxOrderDollars ?? 25;
  const market = snapshot?.market ?? null;
  const position = snapshot?.position ?? null;

  useEffect(() => {
    if (snapshotMaxOrderDollars !== undefined) {
      setCapDraft(String(snapshotMaxOrderDollars));
    }
  }, [snapshotMaxOrderDollars]);

  useEffect(() => {
    if (pendingOrder && market?.ticker !== pendingOrder.ticker) {
      setPendingOrder(null);
    }
  }, [market?.ticker, pendingOrder]);

  const connectMutation = useMutation({
    mutationFn: (input: {
      apiKeyId: string;
      privateKeyPem: string;
      maxOrderDollars: number;
    }) => transport.rpc.kalshi.connect.mutate(input),
    onSuccess: async (result) => {
      if (!result.ok) {
        setSettingsError(result.error);
        return;
      }
      setSettingsError(null);
      setPrivateKeyDraft("");
      setApiKeyIdDraft("");
      setSettingsOpen(false);
      setReplacingKey(false);
      setOrderBanner({
        tone: "success",
        text: `Connected (${result.maskedApiKeyId}) • Cap $${result.maxOrderDollars.toFixed(2)}`,
      });
      await queryClient.invalidateQueries({ queryKey: SNAPSHOT_QUERY_KEY });
    },
    onError: (err) => {
      setSettingsError(err instanceof Error ? err.message : String(err));
    },
  });

  const updateCapMutation = useMutation({
    mutationFn: (maxOrderDollars: number) =>
      transport.rpc.kalshi.setMaxOrderDollars.mutate({ maxOrderDollars }),
    onSuccess: async (result) => {
      if (!result.ok) {
        setSettingsError(result.error);
        return;
      }
      setSettingsError(null);
      setOrderBanner({
        tone: "success",
        text: `Max order cap updated to $${result.maxOrderDollars.toFixed(2)}.`,
      });
      await queryClient.invalidateQueries({ queryKey: SNAPSHOT_QUERY_KEY });
    },
    onError: (err) => {
      setSettingsError(err instanceof Error ? err.message : String(err));
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: () => transport.rpc.kalshi.disconnect.mutate(),
    onSuccess: async () => {
      setSettingsError(null);
      setPendingOrder(null);
      setReplacingKey(false);
      setSettingsOpen(false);
      setOrderBanner(null);
      await queryClient.invalidateQueries({ queryKey: SNAPSHOT_QUERY_KEY });
    },
    onError: (err) => {
      setSettingsError(err instanceof Error ? err.message : String(err));
    },
  });

  const placeOrderMutation = useMutation({
    mutationFn: (order: PendingOrder) =>
      transport.rpc.kalshi.placeOrder.mutate({
        ticker: order.ticker,
        action: order.action,
        count: order.count,
        limitPriceDollars: order.limitPriceDollars,
        exchangeIndex: order.exchangeIndex,
      }),
    onSuccess: async (result, order) => {
      setPendingOrder(null);
      if (!result.ok) {
        setOrderBanner({ tone: "error", text: result.error });
        return;
      }
      const filledNum = Number(result.order.fillCount);
      if (Number.isFinite(filledNum) && filledNum <= 0) {
        setOrderBanner({
          tone: "error",
          text: `${order.sideLabel}: 0 filled — live price moved past your ${formatCents(order.limitPriceDollars)} limit.`,
        });
      } else {
        const effectiveFillPrice =
          result.order.averageFillPrice !== null
            ? order.action === "buy_no" || order.action === "sell_no"
              ? 1 - result.order.averageFillPrice
              : result.order.averageFillPrice
            : null;
        setOrderBanner({
          tone: "success",
          text: `${order.sideLabel}: ${result.order.fillCount}/${order.count} filled${
            effectiveFillPrice !== null
              ? ` @ ${formatCents(effectiveFillPrice)}`
              : ""
          } (${result.order.orderId || "submitted"}).`,
        });
      }
      await queryClient.invalidateQueries({ queryKey: SNAPSHOT_QUERY_KEY });
    },
    onError: (err) => {
      setPendingOrder(null);
      setOrderBanner({
        tone: "error",
        text: err instanceof Error ? err.message : String(err),
      });
    },
  });

  const countdown = formatCountdown(market?.closeTime, nowMs);
  const parsedCount = Number(contractCountRaw);
  const validCount =
    Number.isFinite(parsedCount) && parsedCount > 0 ? parsedCount : 0;

  const yesAsk = market?.yesAskDollars ?? null;
  const noAsk = market?.noAskDollars ?? null;
  const yesBuyCost =
    yesAsk !== null && validCount > 0
      ? Number((validCount * yesAsk).toFixed(2))
      : null;
  const noBuyCost =
    noAsk !== null && validCount > 0
      ? Number((validCount * noAsk).toFixed(2))
      : null;

  const yesOverCap = yesBuyCost !== null && yesBuyCost > maxOrderDollars + 1e-9;
  const noOverCap = noBuyCost !== null && noBuyCost > maxOrderDollars + 1e-9;

  const quoteAgeSec = snapshot
    ? Math.max(0, Math.floor((nowMs - snapshot.updatedAt) / 1000))
    : null;

  const livePendingPriceDollars = pendingOrder
    ? pendingOrder.action === "buy_yes"
      ? (market?.yesAskDollars ?? null)
      : pendingOrder.action === "buy_no"
        ? (market?.noAskDollars ?? null)
        : pendingOrder.action === "sell_yes"
          ? (market?.yesBidDollars ?? null)
          : (market?.noBidDollars ?? null)
    : null;

  const pendingPriceMoved =
    pendingOrder !== null &&
    livePendingPriceDollars !== null &&
    Math.abs(livePendingPriceDollars - pendingOrder.limitPriceDollars) >=
      0.0005;

  const showSetupCard =
    !snapshotQuery.isPending && (!connected || settingsOpen);

  const stageOrder = (
    action: KalshiOrderAction,
    priceDollars: number | null,
    count: number,
    sideLabel: string,
  ) => {
    if (!connected) {
      setPendingOrder(null);
      setSettingsOpen(true);
      setOrderBanner({
        tone: "error",
        text: "Connect your Kalshi API key below to submit live orders.",
      });
      return;
    }
    if (!market || priceDollars === null || !(count > 0)) return;
    const estimatedDollars = Number((count * priceDollars).toFixed(2));
    if (
      (action === "buy_yes" || action === "buy_no") &&
      estimatedDollars > maxOrderDollars + 1e-9
    ) {
      setOrderBanner({
        tone: "error",
        text: `Order cost ${formatUsd(estimatedDollars)} exceeds max order cap of ${formatUsd(maxOrderDollars)}.`,
      });
      return;
    }
    setOrderBanner(null);
    setPendingOrder({
      ticker: market.ticker,
      action,
      count,
      limitPriceDollars: priceDollars,
      exchangeIndex: market.exchangeIndex,
      sideLabel,
      estimatedDollars,
    });
  };

  const handleConnectSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const parsedCap = Number(capDraft);
    if (!Number.isFinite(parsedCap) || parsedCap <= 0) {
      setSettingsError("Max order cap must be greater than $0.");
      return;
    }
    setSettingsError(null);
    connectMutation.mutate({
      apiKeyId: apiKeyIdDraft,
      privateKeyPem: privateKeyDraft,
      maxOrderDollars: parsedCap,
    });
  };

  const handleUpdateCapSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const parsedCap = Number(capDraft);
    if (!Number.isFinite(parsedCap) || parsedCap <= 0) {
      setSettingsError("Max order cap must be greater than $0.");
      return;
    }
    setSettingsError(null);
    updateCapMutation.mutate(parsedCap);
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden text-xs">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="font-semibold tracking-tight text-foreground">
              Kalshi BTC 15m
            </span>
            <Badge
              variant={countdown.urgent ? "destructive" : "secondary"}
              className="font-mono text-[11px] tabular-nums"
            >
              {countdown.label}
            </Badge>
          </div>
          <p className="truncate font-mono text-[10px] text-muted-foreground">
            {market ? market.ticker : "Waiting for active KXBTC15M window"}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {connected ? (
            <Badge
              variant="outline"
              className="gap-1 border-emerald-500/40 text-[11px] text-emerald-600 dark:text-emerald-400"
            >
              <span
                className="size-1.5 rounded-full bg-emerald-500"
                aria-hidden="true"
              />
              {snapshot?.balance
                ? formatUsd(snapshot.balance.balanceDollars)
                : "Live"}
            </Badge>
          ) : (
            <Badge
              variant="outline"
              className="text-[11px] text-muted-foreground"
            >
              Offline
            </Badge>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Refresh Kalshi quote"
            onClick={() => void snapshotQuery.refetch()}
          >
            <RefreshCw
              className={cn(
                "size-3.5",
                snapshotQuery.isFetching && "animate-spin",
              )}
            />
          </Button>
          {connected && (
            <Button
              type="button"
              variant={settingsOpen ? "secondary" : "ghost"}
              size="icon"
              className="size-7"
              aria-label="Kalshi settings"
              aria-pressed={settingsOpen}
              onClick={() => {
                setSettingsError(null);
                setReplacingKey(false);
                setSettingsOpen((open) => !open);
              }}
            >
              <Settings className="size-3.5" />
            </Button>
          )}
          {onClose && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label="Close Kalshi panel"
              onClick={onClose}
            >
              <XIcon className="size-3.5" />
            </Button>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-3">
        <div className="rounded-md border bg-card/60 p-2.5">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Strike
              </div>
              <div className="font-mono text-sm font-semibold tabular-nums">
                {formatUsd(market?.strikeDollars)}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                BTC Spot
              </div>
              <div className="font-mono text-sm font-semibold tabular-nums">
                {formatUsd(snapshot?.spotUsd)}
              </div>
            </div>
          </div>

          <div className="mt-2 flex items-center justify-between border-t pt-1.5">
            <span className="text-[11px] text-muted-foreground">vs Strike</span>
            <span
              className={cn(
                "font-mono text-xs font-semibold tabular-nums",
                snapshot?.distanceDollars != null &&
                  snapshot.distanceDollars > 0
                  ? "text-emerald-600 dark:text-emerald-400"
                  : snapshot?.distanceDollars != null &&
                      snapshot.distanceDollars < 0
                    ? "text-rose-600 dark:text-rose-400"
                    : "text-muted-foreground",
              )}
            >
              {snapshot?.distanceDollars != null ? (
                <>
                  {formatSignedUsd(snapshot.distanceDollars)}
                  {snapshot.distancePercent != null
                    ? ` (${snapshot.distancePercent >= 0 ? "+" : ""}${snapshot.distancePercent.toFixed(2)}%)`
                    : ""}
                </>
              ) : (
                "—"
              )}
            </span>
          </div>

          {quoteAgeSec !== null && (
            <div className="mt-1 flex items-center justify-between text-[10px]">
              <span className="text-muted-foreground">Quote feed (1s)</span>
              <span
                className={cn(
                  "font-mono tabular-nums",
                  quoteAgeSec >= 5
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-muted-foreground",
                )}
              >
                {quoteAgeSec === 0
                  ? "Live · just now"
                  : `Live · ${quoteAgeSec}s ago`}
              </span>
            </div>
          )}
        </div>

        {snapshot?.marketError && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive">
            {snapshot.marketError}
          </div>
        )}

        {snapshot?.accountError && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
            {snapshot.accountError}
          </div>
        )}

        <div className="flex flex-col gap-2 rounded-md border bg-card/40 p-2.5">
          <div className="flex items-center justify-between gap-2">
            <label
              htmlFor="kalshi-contract-count"
              className="text-[11px] font-medium text-muted-foreground"
            >
              Contracts (cap {formatUsd(maxOrderDollars)})
            </label>
            <div className="flex items-center gap-1">
              {CONTRACT_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setContractCountRaw(String(preset))}
                  className={cn(
                    "rounded border px-1.5 py-0.5 font-mono text-[10px] transition-colors",
                    parsedCount === preset
                      ? "border-primary bg-primary/15 text-foreground"
                      : "border-border text-muted-foreground hover:text-foreground",
                  )}
                >
                  {preset}
                </button>
              ))}
            </div>
          </div>

          <Input
            id="kalshi-contract-count"
            aria-label="Contracts"
            type="number"
            min={1}
            step="1"
            className="h-8 font-mono text-xs tabular-nums"
            value={contractCountRaw}
            onChange={(event) => {
              setContractCountRaw(event.target.value);
              setPendingOrder(null);
            }}
          />

          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              className="h-9 bg-emerald-600 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
              disabled={
                !market ||
                yesAsk === null ||
                validCount <= 0 ||
                yesOverCap ||
                placeOrderMutation.isPending
              }
              onClick={() =>
                stageOrder("buy_yes", yesAsk, validCount, "Buy YES")
              }
            >
              Buy YES ({formatCents(yesAsk)})
            </Button>
            <Button
              type="button"
              className="h-9 bg-rose-600 text-xs font-semibold text-white hover:bg-rose-500 disabled:opacity-50"
              disabled={
                !market ||
                noAsk === null ||
                validCount <= 0 ||
                noOverCap ||
                placeOrderMutation.isPending
              }
              onClick={() => stageOrder("buy_no", noAsk, validCount, "Buy NO")}
            >
              Buy NO ({formatCents(noAsk)})
            </Button>
          </div>

          {(yesBuyCost !== null || noBuyCost !== null) && (
            <div className="grid grid-cols-2 gap-2 text-center font-mono text-[10px] tabular-nums text-muted-foreground">
              <span>
                {yesBuyCost !== null ? `Est. ${formatUsd(yesBuyCost)}` : "—"}
              </span>
              <span>
                {noBuyCost !== null ? `Est. ${formatUsd(noBuyCost)}` : "—"}
              </span>
            </div>
          )}

          {(yesOverCap || noOverCap) && (
            <div className="text-[11px] text-amber-600 dark:text-amber-400">
              {yesOverCap && `YES order (${formatUsd(yesBuyCost)}) `}
              {yesOverCap && noOverCap && "• "}
              {noOverCap && `NO order (${formatUsd(noBuyCost)}) `}
              exceeds {formatUsd(maxOrderDollars)} cap.
            </div>
          )}
        </div>

        {pendingOrder && (
          <div className="flex flex-col gap-1.5 rounded-md border border-primary/50 bg-primary/10 p-2">
            <div className="text-[11px] font-medium text-foreground">
              Confirm {pendingOrder.sideLabel} {pendingOrder.count} @{" "}
              {formatCents(pendingOrder.limitPriceDollars)} (
              {formatUsd(pendingOrder.estimatedDollars)})
            </div>
            <div className="text-[10px] text-muted-foreground">
              IOC limit: won&apos;t fill worse than{" "}
              {formatCents(pendingOrder.limitPriceDollars)}.
            </div>
            {pendingPriceMoved && livePendingPriceDollars !== null && (
              <div className="flex items-center justify-between gap-2 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-300">
                <span>
                  Live price moved to {formatCents(livePendingPriceDollars)}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-[11px]"
                  disabled={placeOrderMutation.isPending}
                  onClick={() =>
                    stageOrder(
                      pendingOrder.action,
                      livePendingPriceDollars,
                      pendingOrder.count,
                      pendingOrder.sideLabel,
                    )
                  }
                >
                  Update to {formatCents(livePendingPriceDollars)}
                </Button>
              </div>
            )}
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                size="sm"
                className="h-7 flex-1 text-xs"
                disabled={placeOrderMutation.isPending}
                onClick={() => placeOrderMutation.mutate(pendingOrder)}
              >
                {placeOrderMutation.isPending ? "Submitting..." : "Confirm"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2.5 text-xs"
                disabled={placeOrderMutation.isPending}
                onClick={() => setPendingOrder(null)}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {orderBanner && (
          <div
            className={cn(
              "rounded-md border px-2.5 py-1.5 text-[11px]",
              orderBanner.tone === "success"
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                : "border-destructive/40 bg-destructive/10 text-destructive",
            )}
          >
            {orderBanner.text}
          </div>
        )}

        {connected && position && (
          <div className="flex flex-col gap-2 rounded-md border bg-card/60 p-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-foreground">Open Position</span>
              <Badge
                variant={position.side === "yes" ? "default" : "destructive"}
                className="font-mono text-[10px]"
              >
                {position.side.toUpperCase()} × {position.contracts}
              </Badge>
            </div>

            <div className="grid grid-cols-3 gap-1.5 text-[11px]">
              <div>
                <div className="text-[10px] text-muted-foreground">Cost</div>
                <div className="font-mono font-medium tabular-nums">
                  {formatUsd(position.costBasisDollars)}
                </div>
              </div>
              <div>
                <div className="text-[10px] text-muted-foreground">
                  Exit Bid
                </div>
                <div className="font-mono font-medium tabular-nums">
                  {formatCents(position.exitBidDollars)}
                </div>
              </div>
              <div className="text-right">
                <div className="text-[10px] text-muted-foreground">
                  Sell P&amp;L
                </div>
                <div
                  className={cn(
                    "font-mono font-semibold tabular-nums",
                    position.estimatedPnlDollars != null &&
                      position.estimatedPnlDollars >= 0
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-rose-600 dark:text-rose-400",
                  )}
                >
                  {formatSignedUsd(position.estimatedPnlDollars)}
                </div>
              </div>
            </div>

            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 text-xs font-medium"
              disabled={
                !market ||
                position.exitBidDollars === null ||
                placeOrderMutation.isPending
              }
              onClick={() =>
                stageOrder(
                  position.side === "yes" ? "sell_yes" : "sell_no",
                  position.exitBidDollars,
                  position.contracts,
                  `Sell ${position.side.toUpperCase()}`,
                )
              }
            >
              Sell {position.contracts} {position.side.toUpperCase()} @{" "}
              {formatCents(position.exitBidDollars)}
            </Button>
          </div>
        )}

        {snapshotQuery.isPending ? (
          <div className="rounded-md border bg-card/40 p-3 text-center text-[11px] text-muted-foreground">
            Loading Kalshi market…
          </div>
        ) : showSetupCard ? (
          <div className="flex flex-col gap-2 rounded-md border bg-card/40 p-2.5">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1 font-medium text-foreground">
                <ShieldCheck className="size-3.5 text-emerald-500" />
                {connected
                  ? "Kalshi Account & Risk Cap"
                  : "Connect Live Kalshi Key"}
              </span>
              {connected && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-[11px]"
                  onClick={() => setSettingsOpen(false)}
                >
                  Done
                </Button>
              )}
            </div>

            {connected && !replacingKey ? (
              <div className="flex flex-col gap-2">
                <div className="text-[11px] text-muted-foreground">
                  Key:{" "}
                  <span className="font-mono text-foreground">
                    {snapshot?.maskedApiKeyId}
                  </span>
                </div>
                <form
                  onSubmit={handleUpdateCapSubmit}
                  className="flex items-end gap-1.5"
                >
                  <div className="flex-1">
                    <label
                      htmlFor="kalshi-cap-update"
                      className="mb-1 block text-[11px] text-muted-foreground"
                    >
                      Max Order ($)
                    </label>
                    <Input
                      id="kalshi-cap-update"
                      type="number"
                      min={1}
                      step="1"
                      className="h-8 font-mono text-xs"
                      value={capDraft}
                      onChange={(event) => setCapDraft(event.target.value)}
                    />
                  </div>
                  <Button
                    type="submit"
                    size="sm"
                    className="h-8 text-xs"
                    disabled={updateCapMutation.isPending}
                  >
                    {updateCapMutation.isPending ? "Saving..." : "Save Cap"}
                  </Button>
                </form>
                <div className="flex items-center justify-between gap-2 pt-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 text-[11px]"
                    onClick={() => setReplacingKey(true)}
                  >
                    Replace Key
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    className="h-7 gap-1 text-[11px]"
                    disabled={disconnectMutation.isPending}
                    onClick={() => disconnectMutation.mutate()}
                  >
                    <Unplug className="size-3" />
                    Disconnect
                  </Button>
                </div>
              </div>
            ) : (
              <form
                onSubmit={handleConnectSubmit}
                className="flex flex-col gap-2"
              >
                <p className="text-[11px] text-muted-foreground">
                  Encrypted locally on this machine. Live orders only submit
                  after you confirm.
                </p>
                <div>
                  <label
                    htmlFor="kalshi-api-key-id"
                    className="mb-1 block text-[11px] text-muted-foreground"
                  >
                    API Key ID
                  </label>
                  <Input
                    id="kalshi-api-key-id"
                    placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                    className="h-8 font-mono text-xs"
                    autoComplete="off"
                    value={apiKeyIdDraft}
                    onChange={(event) => setApiKeyIdDraft(event.target.value)}
                  />
                </div>
                <div>
                  <label
                    htmlFor="kalshi-private-key-pem"
                    className="mb-1 block text-[11px] text-muted-foreground"
                  >
                    Private Key (RSA or Ed25519 PEM)
                  </label>
                  <Textarea
                    id="kalshi-private-key-pem"
                    rows={3}
                    placeholder="-----BEGIN PRIVATE KEY-----"
                    className="min-h-14 font-mono text-[11px]"
                    spellCheck={false}
                    value={privateKeyDraft}
                    onChange={(event) => setPrivateKeyDraft(event.target.value)}
                  />
                </div>
                <div>
                  <label
                    htmlFor="kalshi-max-order-dollars"
                    className="mb-1 block text-[11px] text-muted-foreground"
                  >
                    Max Order Cap ($)
                  </label>
                  <Input
                    id="kalshi-max-order-dollars"
                    type="number"
                    min={1}
                    step="1"
                    className="h-8 font-mono text-xs"
                    value={capDraft}
                    onChange={(event) => setCapDraft(event.target.value)}
                  />
                </div>
                <div className="flex items-center gap-2 pt-0.5">
                  <Button
                    type="submit"
                    size="sm"
                    className="h-8 flex-1 text-xs"
                    disabled={connectMutation.isPending}
                  >
                    {connectMutation.isPending
                      ? "Verifying..."
                      : "Save & Connect"}
                  </Button>
                  {connected && replacingKey && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 text-xs"
                      onClick={() => {
                        setReplacingKey(false);
                        setSettingsError(null);
                      }}
                    >
                      Back
                    </Button>
                  )}
                </div>
              </form>
            )}

            {settingsError && (
              <div className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
                {settingsError}
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

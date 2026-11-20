// Purpose: Compile and execute every shipped file against real Tea with deterministic OHLCV.
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  createNode,
  DataStream,
  pineBuiltinSupplier,
  tea,
  type Datum,
  type Node,
} from "tea";
import { BarsSeries } from "@openchart/feed";
import { marketContext } from "@openchart/server/tea/source";
import { columnSchema } from "@openchart/server/tea/wiring";
import { from } from "rxjs";
import { indicatorCatalog, indicatorGoalKeys } from "./catalog";

/**
 * Bind 160 hourly bars to a script and to each of its request children, the
 * way TeaService wires a live chart: timed rows, the newest still forming,
 * every unread column ignored, and columns a bar does not name read as `0`.
 */
function bindBars(
  node: Node,
  bar: (index: number) => Record<string, number>,
): Node {
  const stream = (columns: readonly string[]) =>
    new DataStream(
      columnSchema(columns),
      from(
        Array.from({ length: 160 }, (_, i) => ({
          time: Date.UTC(2026, 0, 5) + i * 3_600_000,
          provisional: i === 159,
          ...Object.fromEntries(
            columns.map((name) => [name, bar(i)[name] ?? 0]),
          ),
        })),
      ),
    );
  const names = (schema: typeof node.module.inputs.schema) =>
    schema.fields.map((field) => field.name);
  return node.module.requests.reduce(
    (bound, request) =>
      bound.bind(stream(names(request.module.inputs.schema)), [request.name]),
    node.bind(stream(names(node.module.inputs.schema))),
  );
}

/** The numbers one output row carries: a plot's value, or a profile's row bounds and lengths. */
function outputNumbers(value: unknown): (number | null)[] {
  // A profile is written only on the rows the chart draws.
  if (value === null || value === undefined) return [];
  const profile = value as {
    rows?: { low: number; high: number; segments: { value: number }[] }[];
    levels?: { y: number }[];
  };
  if (profile.rows)
    return [
      ...profile.rows.flatMap((row) => [
        row.low,
        row.high,
        ...row.segments.map((segment) => segment.value),
      ]),
      ...(profile.levels ?? []).map((level) => level.y),
    ];
  const zone = value as {
    top?: number | null;
    bottom?: number | null;
  };
  if ("top" in zone && "bottom" in zone) {
    return [zone.top ?? null, zone.bottom ?? null];
  }
  const barColor = value as {
    color?: { r: number; g: number; b: number; a: number } | null;
    series?: number | null;
  };
  if (!("series" in barColor)) {
    return barColor.color
      ? [barColor.color.r, barColor.color.g, barColor.color.b, barColor.color.a]
      : [];
  }
  return [barColor.series ?? null];
}

const market = Schema.decodeUnknownSync(BarsSeries)({
  provider: "yfinance",
  listing: { symbol: "MSFT", currency: "USD" },
  resolution: "1h",
  session: "regular",
  adjustment: "split",
});

describe("indicator templates", () => {
  it("contains 72 originals and 30 curated studies without duplicate identities", () => {
    expect(indicatorCatalog).toHaveLength(102);
    expect(new Set(indicatorCatalog.map((entry) => entry.id)).size).toBe(102);
    expect(indicatorCatalog.filter((entry) => entry.discovery)).toHaveLength(
      30,
    );
  });
  it("provides discovery content and supported goals for every starter", () => {
    const representedGoals = new Set<string>();
    for (const entry of indicatorCatalog) {
      expect(entry.prompt.trim(), entry.id).not.toBe("");
      expect(entry.description.trim(), entry.id).not.toBe("");
      expect(entry.goals.length, entry.id).toBeGreaterThan(0);
      for (const goal of entry.goals) {
        expect(indicatorGoalKeys, entry.id).toContain(goal);
        representedGoals.add(goal);
      }
    }
    expect([...representedGoals].sort()).toEqual([...indicatorGoalKeys].sort());
  });
  // Curated visual/confirmation behavior is exercised in featured-studies.test.ts.
  for (const entry of indicatorCatalog.filter((entry) => !entry.discovery)) {
    it(entry.name, async () => {
      const source = await readFile(
        new URL(`./builtins/${entry.id}.tea`, import.meta.url),
        "utf8",
      );
      // Bound like TeaService binds a chart's script: with the market's facts
      // and the chart's timeframe, which request lines such as
      // request.security(syminfo.tickerid, ...) need.
      const compiled = tea`${source}`;
      const node = createNode(
        compiled.module.bind(
          {},
          marketContext(compiled.module.inputs, [market], market.resolution),
        ),
        pineBuiltinSupplier(),
      );
      const prices = (i: number): Record<string, number> => {
        const close = 100 + i * 0.1 + Math.sin(i / 4) * 3;
        return {
          close,
          open: close - 0.5,
          high: close + 2,
          low: close - 2,
          volume: 1000 + i,
          hl2: close,
          hlc3: close,
          ohlc4: close - 0.125,
        };
      };
      const rows = Array.from({ length: 160 }, (_, i) => prices(i));
      const run = bindBars(node, prices);
      const output: Datum[] = [];
      try {
        await new Promise<void>((resolve, reject) =>
          run.to({
            next: (row) => output.push(row),
            error: reject,
            complete: resolve,
          }),
        );
        expect(output).toHaveLength(rows.length);
        for (const field of node.module.outputs.schema.fields.filter((f) =>
          f.metadata.has("tea:write"),
        )) {
          if (entry.id === "order-flow-bubbles") {
            const allValues = output.flatMap((row) =>
              outputNumbers(row[field.name]),
            );
            expect(
              allValues.every(
                (value) =>
                  value === null ||
                  Number.isFinite(value) ||
                  Number.isNaN(value),
              ),
              `${entry.id}/${field.name}`,
            ).toBe(true);
            continue;
          }
          const values = outputNumbers(output.at(-1)![field.name]);
          expect(values.length, `${entry.id}/${field.name}`).toBeGreaterThan(0);
          expect(
            values.every((value) => Number.isFinite(value)),
            `${entry.id}/${field.name}`,
          ).toBe(true);
        }
        const last = output.at(-1)!;
        if (entry.id === "sma") {
          const expected =
            rows
              .slice(-14)
              .reduce((total, row) => total + Number(row.close), 0) / 14;
          expect((last.value as { series: number }).series).toBeCloseTo(
            expected,
            8,
          );
        }
        if (entry.id === "volume")
          expect((last.histogram as { series: number }).series).toBe(1159);
        const flat = bindBars(node, () => ({}));
        try {
          await new Promise<void>((resolve, reject) =>
            flat.to({
              next: (row) => {
                for (const field of node.module.outputs.schema.fields.filter(
                  (field) => field.metadata.has("tea:write"),
                )) {
                  for (const value of outputNumbers(row[field.name]))
                    expect(
                      value === null ||
                        Number.isFinite(value) ||
                        Number.isNaN(value),
                      `${entry.id} must not emit infinity for flat prices/zero volume`,
                    ).toBe(true);
                }
              },
              error: reject,
              complete: resolve,
            }),
          );
        } finally {
          flat.dispose();
        }
      } finally {
        run.dispose();
        node.dispose();
      }
    });
  }
});

it.each([
  ["sma", { value: 593.5 }],
  ["ema", { value: 593.5 }],
  ["rsi", { value: 100 }],
  ["macd", { macd: 7, signal: 7, histogram: 0 }],
  [
    "bollinger-bands",
    {
      basis: 590.5,
      upper: 590.5 + 2 * Math.sqrt(33.25),
      lower: 590.5 - 2 * Math.sqrt(33.25),
    },
  ],
  ["volume", { histogram: 1000 }],
] as const)(
  "%s matches a closed-form linear-price reference",
  async (id, expected) => {
    const source = await readFile(
      new URL(`./builtins/${id}.tea`, import.meta.url),
      "utf8",
    );
    const node = tea`${source}`;
    const rows = Array.from({ length: 600 }, (_, index) => {
      const close = index + 1;
      const values: Record<string, number> = {
        close,
        open: close,
        high: close + 2,
        low: close - 2,
        volume: 1000,
        hl2: close,
        hlc3: close,
        ohlc4: close,
      };
      return Object.fromEntries(
        node.module.inputs.schema.fields.map((field) => [
          field.name,
          values[field.name],
        ]),
      );
    });
    const run = node.bind(
      new DataStream(node.module.inputs.schema, from(rows)),
    );
    let last: Datum | undefined;
    try {
      await new Promise<void>((resolve, reject) =>
        run.to({
          next: (row) => {
            last = row;
          },
          complete: resolve,
          error: reject,
        }),
      );
      for (const [output, value] of Object.entries(expected))
        expect((last![output] as { series: number }).series).toBeCloseTo(
          value,
          7,
        );
    } finally {
      run.dispose();
      node.dispose();
    }
  },
);

it("order-flow-bubbles emits editable-color volume orbs, absorption orbs and optional candles without lookahead", async () => {
  const source = await readFile(
    new URL("./builtins/order-flow-bubbles.tea", import.meta.url),
    "utf8",
  );
  const compiled = tea`${source}`;
  const runScenario = async (
    bars: readonly {
      time: number;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    }[],
    parameters: Record<string, string | number | boolean> = {},
  ) => {
    const node = createNode(
      compiled.module.bind(
        parameters,
        marketContext(compiled.module.inputs, [market], market.resolution),
      ),
      pineBuiltinSupplier(),
    );
    const columns = node.module.inputs.schema.fields.map((field) => field.name);
    const stream = new DataStream(
      columnSchema(columns),
      from(
        bars.map((bar, index) => {
          const derived: Record<string, number> = {
            ...bar,
            hl2: (bar.high + bar.low) / 2,
            hlc3: (bar.high + bar.low + bar.close) / 3,
            ohlc4: (bar.open + bar.high + bar.low + bar.close) / 4,
          };
          return {
            time: bar.time,
            provisional: index === bars.length - 1,
            ...Object.fromEntries(
              columns.map((column) => [column, derived[column] ?? 0]),
            ),
          };
        }),
      ),
    );
    const run = node.bind(stream);
    const rows: Datum[] = [];
    try {
      await new Promise<void>((resolve, reject) =>
        run.to({
          next: (row) => rows.push(structuredClone(row)),
          error: reject,
          complete: resolve,
        }),
      );
      return rows;
    } finally {
      run.dispose();
      node.dispose();
    }
  };

  const bars = Array.from({ length: 65 }, (_, i) => {
    const time = Date.UTC(2026, 0, 5) + i * 3_600_000;
    if (i === 28) {
      return {
        time,
        open: 101,
        high: 103.8,
        low: 100.8,
        close: 103.5,
        volume: 4000,
      };
    }
    if (i === 55) {
      return {
        time,
        open: 106,
        high: 106.5,
        low: 96.5,
        close: 105,
        volume: 8000,
      };
    }
    return {
      time,
      open: 100,
      high: 101.2,
      low: 99.8,
      close: 100.5,
      volume: 1000,
    };
  });

  const output = await runScenario(bars);
  expect(output).toHaveLength(bars.length);

  // Focus strictly on orbs and optional candles; no tan imbalance boxes or duplicate session profile.
  const firstRow = output[0]!;
  expect(firstRow).not.toHaveProperty("bull_imbalance");
  expect(firstRow).not.toHaveProperty("bear_imbalance");
  expect(firstRow).not.toHaveProperty("profile");

  // Baseline low-volume bar emits no volume orbs and leaves candle color unset by default.
  for (const key of [
    "bubble_xs",
    "bubble_s",
    "bubble_m",
    "bubble_l",
    "bubble_xl",
  ]) {
    expect(
      Number.isFinite((output[10]![key] as { series: number }).series),
    ).toBe(false);
  }
  expect((output[10]!.candles as { color: unknown }).color).toBeNull();

  // Bullish burst fires translucent lime green bubble_l (75% opacity => alpha 191).
  const bullBurst = output[28]!.bubble_l as {
    series: number;
    color: { r: number; g: number; b: number; a: number };
  };
  expect(Number.isFinite(bullBurst.series)).toBe(true);
  expect(bullBurst.color).toMatchObject({ r: 124, g: 255, b: 46, a: 191 });

  // Climax bearish rejection fires red bubble_xl (a=191) AND nested green absorb_l (a=217).
  const climaxOuter = output[55]!.bubble_xl as {
    series: number;
    color: { r: number; g: number; b: number; a: number };
  };
  const climaxNested = output[55]!.absorb_l as {
    series: number;
    color: { r: number; g: number; b: number; a: number };
  };
  expect(Number.isFinite(climaxOuter.series)).toBe(true);
  expect(climaxOuter.color).toMatchObject({ r: 255, g: 32, b: 32, a: 191 });
  expect(Number.isFinite(climaxNested.series)).toBe(true);
  expect(climaxNested.color).toMatchObject({ r: 124, g: 255, b: 46, a: 217 });

  // Custom #RRGGBBAA and #RRGGBB color overrides propagate to orbs, absorption orbs, and candles.
  const custom = await runScenario(bars, {
    buyOrbColor: "#00AAFF80",
    sellOrbColor: "#FF880066",
    buyAbsorbColor: "#FFEE00CC",
    colorCandles: true,
    bullCandleColor: "#11EE99",
    bearCandleColor: "#AA22CC",
  });
  expect((custom[28]!.bubble_l as { color: unknown }).color).toMatchObject({
    r: 0,
    g: 170,
    b: 255,
    a: 128,
  });
  expect((custom[55]!.bubble_xl as { color: unknown }).color).toMatchObject({
    r: 255,
    g: 136,
    b: 0,
    a: 102,
  });
  expect((custom[55]!.absorb_l as { color: unknown }).color).toMatchObject({
    r: 255,
    g: 238,
    b: 0,
    a: 204,
  });
  expect((custom[28]!.candles as { color: unknown }).color).toMatchObject({
    r: 17,
    g: 238,
    b: 153,
    a: 255,
  });
  expect((custom[55]!.candles as { color: unknown }).color).toMatchObject({
    r: 170,
    g: 34,
    b: 204,
    a: 255,
  });

  // Confirmed historical bar-level visuals never change when later bars arrive.
  const prefix = await runScenario(bars.slice(0, 60));
  const keys = [
    "bubble_xs",
    "bubble_s",
    "bubble_m",
    "bubble_l",
    "bubble_xl",
    "absorb_s",
    "absorb_l",
    "candles",
  ];
  for (let i = 0; i < 59; i++) {
    for (const key of keys) {
      expect(prefix[i]![key]).toEqual(output[i]![key]);
    }
  }
});

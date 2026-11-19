// Purpose: Persist encrypted Kalshi API credentials and per-order risk caps in Credential.Service.

import { Credential } from "@openchart/server/access/credential";
import { Integration } from "@openchart/server/access/integration";
import { Effect } from "effect";

import {
  validateKalshiPrivateKey,
  type KalshiCredentials,
  type KalshiKeyAlgorithm,
} from "./client";

/** Synthetic integration namespace used to store encrypted Kalshi credentials. */
export const KALSHI_INTEGRATION_ID = Integration.IntegrationID.make("kalshi");

/** Default per-order safety cap in dollars when connecting a new Kalshi key. */
export const DEFAULT_MAX_ORDER_DOLLARS = 25;

/** Stored Kalshi credentials plus server-enforced risk cap. */
export interface StoredKalshiCredentials extends KalshiCredentials {
  readonly maxOrderDollars: number;
}

/** Public summary returned to the UI without exposing any private key material. */
export interface SavedKalshiCredentialSummary {
  readonly maskedApiKeyId: string;
  readonly maxOrderDollars: number;
  readonly algorithm: KalshiKeyAlgorithm;
}

/** Redact a Kalshi API Key ID for safe display in status badges and headers. @example maskApiKeyId("9f4a8b1c-2d3e-4f5a-9b8c-1234567890ab") */
export function maskApiKeyId(apiKeyId: string): string {
  const trimmed = apiKeyId.trim();
  if (trimmed.length <= 4) {
    return "****";
  }
  if (trimmed.length <= 8) {
    return `${trimmed.slice(0, 2)}...${trimmed.slice(-2)}`;
  }
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

/** Read and decrypt the active Kalshi API key and cap from OpenChart's SQLite store. @example Effect.runPromise(readKalshiCredentials) */
export const readKalshiCredentials = Effect.gen(function* () {
  const credentials = yield* Credential.Service;
  const active = yield* credentials.list(KALSHI_INTEGRATION_ID, true);
  const entry = active[0];
  if (!entry || entry.value.type !== "key") {
    return null;
  }

  const rawKeyId = entry.value.metadata?.apiKeyId;
  if (typeof rawKeyId !== "string" || rawKeyId.trim().length === 0) {
    return null;
  }

  const rawCap = entry.value.metadata?.maxOrderDollars;
  const maxOrderDollars =
    typeof rawCap === "number" && Number.isFinite(rawCap) && rawCap > 0
      ? rawCap
      : DEFAULT_MAX_ORDER_DOLLARS;

  return {
    apiKeyId: rawKeyId.trim(),
    privateKeyPem: entry.value.key,
    maxOrderDollars,
  } satisfies StoredKalshiCredentials;
});

/** Validate, encrypt, and atomically store Kalshi API credentials and max order cap. @example saveKalshiCredentials({ apiKeyId, privateKeyPem, maxOrderDollars: 25 }) */
export function saveKalshiCredentials(input: {
  readonly apiKeyId: string;
  readonly privateKeyPem: string;
  readonly maxOrderDollars: number;
}): Effect.Effect<
  SavedKalshiCredentialSummary,
  Credential.StorageFailed | Error,
  Credential.Service
> {
  return Effect.gen(function* () {
    const apiKeyId = input.apiKeyId.trim();
    if (apiKeyId.length === 0) {
      return yield* Effect.fail(new Error("Kalshi API Key ID is required."));
    }
    if (!Number.isFinite(input.maxOrderDollars) || input.maxOrderDollars <= 0) {
      return yield* Effect.fail(
        new Error("Max order cap must be a positive dollar amount."),
      );
    }

    const { pem, algorithm } = yield* Effect.try({
      try: () => validateKalshiPrivateKey(input.privateKeyPem),
      catch: (error) =>
        error instanceof Error ? error : new Error(String(error)),
    });

    const masked = maskApiKeyId(apiKeyId);
    const value = Credential.Key.make({
      type: "key",
      key: pem,
      metadata: {
        apiKeyId,
        maxOrderDollars: Number(input.maxOrderDollars.toFixed(2)),
      },
    });

    const credentials = yield* Credential.Service;
    yield* credentials.create({
      integrationID: KALSHI_INTEGRATION_ID,
      value,
      label: masked,
    });

    return {
      maskedApiKeyId: masked,
      maxOrderDollars: Number(input.maxOrderDollars.toFixed(2)),
      algorithm,
    };
  });
}

/** Update the max per-order dollar cap without resending the stored private key. @example updateKalshiMaxOrderDollars(50) */
export function updateKalshiMaxOrderDollars(
  maxOrderDollars: number,
): Effect.Effect<
  SavedKalshiCredentialSummary | null,
  Credential.StorageFailed | Error,
  Credential.Service
> {
  return Effect.gen(function* () {
    if (!Number.isFinite(maxOrderDollars) || maxOrderDollars <= 0) {
      return yield* Effect.fail(
        new Error("Max order cap must be a positive dollar amount."),
      );
    }
    const existing = yield* readKalshiCredentials;
    if (!existing) {
      return null;
    }
    return yield* saveKalshiCredentials({
      apiKeyId: existing.apiKeyId,
      privateKeyPem: existing.privateKeyPem,
      maxOrderDollars,
    });
  });
}

/** Delete stored Kalshi credentials from the local encrypted database. @example clearKalshiCredentials */
export const clearKalshiCredentials = Effect.gen(function* () {
  const credentials = yield* Credential.Service;
  yield* credentials.clear(KALSHI_INTEGRATION_ID);
});

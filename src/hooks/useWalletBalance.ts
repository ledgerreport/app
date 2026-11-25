import { useState, useCallback, useRef } from "react";
import type { Snapshot, SupportedAsset } from "../types";
import { fetchWalletBalance, type BalanceAtBlock } from "../core/balance";
import { browserRuntime } from "../browserRuntime";
import { StaleRequestError } from "./staleRequest";

interface BalanceResult {
  balance: string | null;
  loading: boolean;
  error: string | null;
}

interface FetchBalanceParams {
  asset: SupportedAsset;
  walletAddress: string;
  timestamp: string;
  snapshot: Snapshot;
}

// Thin React wrapper around src/core/balance.ts (shared with the headless
// CLI): tracks loading/error state for the form. Each request gets a number;
// only the latest one may write state, and reset() invalidates the one in
// flight.
export const useWalletBalance = () => {
  const latestRequest = useRef(0);
  const [result, setResult] = useState<BalanceResult>({
    balance: null,
    loading: false,
    error: null,
  });

  const reset = useCallback(() => {
    latestRequest.current++;
    setResult({ balance: null, loading: false, error: null });
  }, []);

  const fetchBalance = useCallback(async ({ asset, walletAddress, timestamp, snapshot }: FetchBalanceParams): Promise<BalanceAtBlock> => {
    const request = ++latestRequest.current;
    setResult({ balance: null, loading: true, error: null });

    try {
      const result = await fetchWalletBalance(browserRuntime, {
        asset,
        walletAddress,
        date: timestamp,
        snapshot,
      });
      if (request !== latestRequest.current) throw new StaleRequestError();
      setResult({ balance: result.balance, loading: false, error: null });
      // The block is needed by the price lookup (FPS reads its price there).
      return result;
    } catch (error: unknown) {
      // A superseded request must not overwrite the newer request's state.
      if (error instanceof StaleRequestError || request !== latestRequest.current) {
        throw new StaleRequestError();
      }
      setResult({
        balance: null,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
      // Re-throw so the form submit handler short-circuits — there's no point
      // continuing to a price fetch when the balance lookup already failed.
      // Mirrors useCurrencyPrice.fetchPrice, which also re-throws after
      // recording the error in local state.
      throw error;
    }
  }, []);

  return {
    ...result,
    fetchBalance,
    reset,
  };
};

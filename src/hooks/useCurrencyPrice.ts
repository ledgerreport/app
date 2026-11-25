import { useState, useCallback, useRef } from "react";
import { fetchCurrencyPrice, type FetchPriceParams, type PriceQuote } from "../core/price";
import { browserRuntime } from "../browserRuntime";
import { StaleRequestError } from "./staleRequest";

interface CurrencyPriceResult {
  prices: PriceQuote | null;
  loading: boolean;
  error: string | null;
}

// Thin React wrapper around src/core/price.ts (shared with the headless CLI):
// tracks loading/error state for the form. Each request gets a number; only
// the latest one may write state, and reset() invalidates the one in flight.
export const useCurrencyPrice = () => {
  const latestRequest = useRef(0);
  const [result, setResult] = useState<CurrencyPriceResult>({
    prices: null,
    loading: false,
    error: null,
  });

  const fetchPrice = useCallback(async (params: FetchPriceParams) => {
    const request = ++latestRequest.current;
    setResult({ prices: null, loading: true, error: null });

    try {
      const prices = await fetchCurrencyPrice(browserRuntime, params);
      if (request !== latestRequest.current) throw new StaleRequestError();
      setResult({ prices, loading: false, error: null });
      return prices;
    } catch (error: unknown) {
      if (error instanceof StaleRequestError || request !== latestRequest.current) {
        throw new StaleRequestError();
      }
      setResult({
        prices: null,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }, []);

  // Price errors are a normal outcome (not published yet, token unknown to
  // CoinGecko, outside its 365-day window). The form clears them on change
  // so the user can retry: reset() for fields that invalidate the price,
  // clearError() for the currency toggle, which keeps the fetched prices.
  const reset = useCallback(() => {
    latestRequest.current++;
    setResult({ prices: null, loading: false, error: null });
  }, []);
  const clearError = useCallback(() => setResult((current) => ({ ...current, error: null })), []);

  return {
    ...result,
    fetchPrice,
    reset,
    clearError,
  };
};

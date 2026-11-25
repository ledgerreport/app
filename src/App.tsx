import { useEffect, useId, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { useSearchParams } from "react-router-dom";

import { Logo } from "./components/Logo";
import { Footer } from "./components/Footer";
import { SegmentedControl } from "./components/SegmentedControl";
import { SectionRow } from "./components/SectionRow";
import { WalletAddressInput } from "./components/WalletAddressInput";
import { TokenSelect } from "./components/TokenSelect";
import { DateInput } from "./components/DateInput";
import { OutputPanel } from "./components/OutputPanel";
import { LoadingSpinner } from "./components/LoadingSpinner";

import { useWalletBalance } from "./hooks/useWalletBalance";
import { useCurrencyPrice } from "./hooks/useCurrencyPrice";
import { generateWalletBalancePDF } from "./utils/pdfGenerator";
import { StaleRequestError } from "./hooks/staleRequest";
import { fetchAssetMap, pickNativeAsset, type AssetMap } from "./core/assets";
import { blockchainLabel } from "./utils/blockchainLabel";
import {
  END_OF_DAY_NOT_REACHED_MESSAGE,
  SNAPSHOTS,
  SNAPSHOT_LABEL,
  SNAPSHOT_UTC_TIME,
  isParsableDay,
  isSnapshot,
  snapshotNotReached,
} from "./utils/snapshot";

import {
  EvmBlockchain,
  NonEvmBlockchain,
  isSupportedBlockchain,
  type Blockchain,
  type Currency,
  type Snapshot,
  type SupportedAsset,
} from "./types";

type FormData = {
  date: string;
  snapshot: Snapshot;
  network: Blockchain;
  asset: SupportedAsset;
  address: string;
  currency: Currency;
};

// Bitcoin first so the default-selected pill (NonEvmBlockchain.BTC) lives in
// the top-left position of the segmented control rather than wrapping into a
// second row on desktop.
const SUPPORTED_NETWORKS: Blockchain[] = [
  ...Object.values(NonEvmBlockchain),
  ...Object.values(EvmBlockchain),
];

const CURRENCIES: FormData["currency"][] = ["CHF", "EUR", "USD"];

// 31 December of the previous year — the wealth-tax record date in
// Switzerland, which is the primary use case for this tool. Used as the
// form default and in the example link, so the example always stays inside
// CoinGecko's 365-day history window.
const previousYearEnd = () => `${new Date().getFullYear() - 1}-12-31`;

const EXAMPLE_ADDRESS = "0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe";

export default function App() {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [assetMap, setAssetMap] = useState<AssetMap | undefined>();
  // Kept apart from `error`: the form-change watcher clears `error` on every
  // field update, but an invalid `?snapshot=` must stay visible until the
  // user explicitly picks Start of day or End of day.
  const [snapshotParamError, setSnapshotParamError] = useState<string | undefined>();
  // The form values of the request whose balance and price are shown. The
  // PDF and the result panel use these, never the live form, so they always
  // describe one and the same request; only the currency stays live.
  const [submittedRequest, setSubmittedRequest] = useState<FormData | null>(null);
  // Number of the latest submit; a form change bumps it, so an older
  // request stops before its price lookup and never reports an error.
  const latestSubmit = useRef(0);

  // Section-heading IDs let us bind each form control to its label via
  // aria-labelledby — keyboard and screen-reader users get a proper
  // association instead of a free-floating h2 sitting next to an unrelated
  // input.
  const blockchainHeadingId = useId();
  const tokenHeadingId = useId();
  const dateHeadingId = useId();
  const snapshotHintId = useId();
  const snapshotErrorId = useId();
  const currencyHeadingId = useId();

  const [urlParams] = useSearchParams();

  const { balance, loading: balanceLoading, error: balanceError, fetchBalance, reset } = useWalletBalance();
  const {
    prices,
    loading: priceLoading,
    error: priceError,
    fetchPrice,
    reset: resetPrice,
    clearError: clearPriceError,
  } = useCurrencyPrice();

  const {
    register,
    handleSubmit,
    formState: { errors, isValid },
    watch,
    setValue,
  } = useForm<FormData>({
    mode: "onChange",
    defaultValues: {
      currency: "CHF",
      network: NonEvmBlockchain.BTC,
      date: previousYearEnd(),
      // End of day: the year-end record needs the balance after the last
      // block of 31 December, not the one at 00:00:00 UTC.
      snapshot: "end",
    },
  });

  // Clear any previous balance + error whenever the form changes. watch()
  // returns a subscription, so we run it inside useEffect with a cleanup to
  // avoid leaking subscribers on every render.
  //
  // Currency changes are a special case: switching CHF/EUR/USD re-renders
  // the fiat line from the already-fetched `prices` state, so wiping the
  // balance would force the user to re-fetch for no reason. But we still
  // clear the errors — an error from a previous fetch attempt shouldn't
  // stay stuck once the user touches the form again, even via the currency
  // toggle. A price error disables submit, so it must be cleared here too,
  // otherwise the user could not retry without reloading the page.
  useEffect(() => {
    const subscription = watch((_value, { name }) => {
      if (name === "currency") {
        setError(undefined);
        clearPriceError();
        return;
      }
      setError(undefined);
      latestSubmit.current++;
      setSubmittedRequest(null);
      reset();
      resetPrice();
    });
    return () => subscription.unsubscribe();
  }, [watch, reset, resetPrice, clearPriceError]);

  const selectedNetwork = watch("network");
  const selectedAsset = watch("asset");
  const selectedCurrency = watch("currency");
  const selectedDate = watch("date");
  const selectedSnapshot = watch("snapshot");

  // End of day for today (or any day whose 23:59:59 UTC is still ahead) does
  // not exist on chain yet; the lookup would return the current balance.
  // An unparseable date is skipped here because DateInput already reports it
  // and blocks submit.
  const snapshotError =
    selectedSnapshot === "end" &&
    isParsableDay(selectedDate) &&
    snapshotNotReached(selectedDate, selectedSnapshot, Date.now())
      ? END_OF_DAY_NOT_REACHED_MESSAGE
      : undefined;

  // Load the supported asset list from the DFX backend and group by chain.
  useEffect(() => {
    fetchAssetMap()
      .then((map) => {
        setAssetMap(map);

        // Pick the default asset for the form's default network (Bitcoin).
        // pickNativeAsset() prefers the chain's native coin so first-time
        // visitors land on BTC rather than an arbitrary first list entry.
        const defaultNetworkAssets = map[NonEvmBlockchain.BTC];
        if (defaultNetworkAssets?.length && !watch("asset")) {
          setValue("asset", pickNativeAsset(defaultNetworkAssets));
        }
      })
      .catch((err) => {
        console.error("Error fetching assets:", err);
        setError("Failed to load available tokens");
      })
      .finally(() => setIsLoading(false));
  }, []);

  // Prefill from URL search params.
  //
  // We pass BOTH `shouldValidate` and `shouldTouch` so a malformed
  // `?date=2099-12-31` surfaces the same error message a typed-in future
  // date would. `shouldValidate` alone runs the validator but leaves the
  // field untouched — DateInput / WalletAddressInput both gate their visible
  // error border + message on `errors.<field>`, and without `shouldTouch`
  // the user sees a disabled Get balance button with no hint why.
  //
  // We depend on `assetMap` so this effect re-fires once the form fields
  // are mounted: the DateInput only renders after `assetMap` loads, and
  // `setValue` is a no-op for fields that aren't registered yet. Re-running
  // post-mount makes sure the validator actually attaches to the field and
  // populates `errors.date`.
  useEffect(() => {
    if (!assetMap) return;
    const addressParam = urlParams.get("address");
    const dateParam = urlParams.get("date");
    if (addressParam) setValue("address", addressParam, { shouldValidate: true, shouldTouch: true });
    if (dateParam) setValue("date", dateParam, { shouldValidate: true, shouldTouch: true });
  }, [urlParams, assetMap]);

  useEffect(() => {
    const networkParam = urlParams.get("network");
    if (!networkParam) return;

    if (isSupportedBlockchain(networkParam)) {
      setValue("network", networkParam);
    } else {
      setError(`Unsupported network in URL parameter: ${networkParam}`);
    }
  }, [urlParams]);

  // `?snapshot=start|end`. Any other value (including an empty one) is an
  // error rather than being replaced by the default.
  useEffect(() => {
    const snapshotParam = urlParams.get("snapshot");
    if (snapshotParam === null) return;

    if (isSnapshot(snapshotParam)) {
      setSnapshotParamError(undefined);
      setValue("snapshot", snapshotParam);
    } else {
      setSnapshotParamError(
        `Invalid snapshot in URL parameter: "${snapshotParam}" — use "start" or "end".`,
      );
    }
  }, [urlParams, setValue]);

  useEffect(() => {
    const tokenParam = urlParams.get("token");
    if (!tokenParam) return;

    const matchedAsset =
      selectedNetwork && assetMap && assetMap[selectedNetwork]?.find((asset) => asset.name === tokenParam);
    if (matchedAsset) {
      setValue("asset", matchedAsset);
    } else if (assetMap) {
      // Never leave a token of another network selected: fall back to this
      // network's native coin, as the sync effect below does without a
      // token parameter, and say why. setValue runs first because the form
      // watcher clears `error` on every change.
      const candidates = selectedNetwork ? assetMap[selectedNetwork] : undefined;
      if (candidates?.length) {
        try {
          setValue("asset", pickNativeAsset(candidates));
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
          return;
        }
      }
      setError(`Token "${tokenParam}" not found in network "${selectedNetwork}"`);
    }
  }, [urlParams, assetMap, selectedNetwork]);

  // Keep the selected asset in sync with the selected network — the URL-param
  // effect above only writes `network`, so we have to mirror the dropdown's
  // onChange behaviour here.
  //
  // When the URL carries a `?token=` param we cede control entirely to the
  // token-param effect above. Reading the param straight off `urlParams`
  // (instead of comparing against `selectedAsset.name`) avoids a render race:
  // when the token-param effect fires `setValue("asset", USDT)`, this effect
  // re-runs in the same batch with a stale `selectedAsset` closure still
  // pointing at the previous network's native coin. Without this short-circuit
  // we'd overwrite the in-flight USDT pick with ETH on every render, looping
  // until React bails out with "Maximum update depth exceeded".
  //
  // Without a token param, the regular sync applies: keep the asset's
  // blockchain matching the selected network, otherwise pick the native coin
  // so the Token select doesn't get stuck on the previous network's choice.
  useEffect(() => {
    if (!assetMap || !selectedNetwork) return;
    if (urlParams.has("token")) return;
    if (selectedAsset && selectedAsset.blockchain === selectedNetwork) return;
    const candidates = assetMap[selectedNetwork];
    if (!candidates?.length) return;
    try {
      setValue("asset", pickNativeAsset(candidates));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [assetMap, selectedNetwork, selectedAsset, urlParams]);

  async function onSubmit(data: FormData) {
    // Balance and price are both read on the asset's own chain; a token left
    // over from another network must never be reported under this one.
    if (!data.asset || data.asset.blockchain !== data.network) {
      setError(
        `The selected token does not belong to ${blockchainLabel(data.network)} — select the token again.`,
      );
      return;
    }
    const submit = ++latestSubmit.current;
    setError(undefined);
    // Invalidate a price lookup of an earlier submit that may still run.
    resetPrice();
    setSubmittedRequest(data);
    const { date, snapshot, address, asset } = data;

    try {
      const { blockNumber } = await fetchBalance({
        asset,
        walletAddress: address,
        timestamp: date,
        snapshot,
      });
      if (submit !== latestSubmit.current) return;

      await fetchPrice({
        asset,
        date,
        snapshot,
        blockNumber,
      });
    } catch (e) {
      // A superseded submit stops quietly; its error belongs to old input.
      if (e instanceof StaleRequestError || submit !== latestSubmit.current) return;
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const generatePDF = async () => {
    try {
      if (!submittedRequest) {
        throw new Error("Fetch the balance and price before generating the PDF.");
      }
      await generateWalletBalancePDF({
        formData: submittedRequest,
        balance,
        prices,
        selectedCurrency,
      });
    } catch (e) {
      console.error("PDF generation failed:", e);
      setError(e instanceof Error ? e.message : `Failed to generate PDF: ${String(e)}`);
    }
  };

  const availableNetworks = assetMap
    ? SUPPORTED_NETWORKS.filter((n) => assetMap[n]?.length)
    : [];

  const isFetching = balanceLoading || priceLoading;
  const visibleError = balanceError || priceError || error || snapshotParamError || undefined;

  return (
    <div className="flex min-h-screen flex-col bg-neutral-150">
      <main className="mx-auto flex w-full max-w-[904px] flex-1 flex-col items-center gap-10 px-4 pt-16">
        <header className="flex w-full flex-col items-center gap-5">
          <Logo />
          <div className="flex flex-col items-center gap-0">
            <h1 className="text-center text-[26px] font-bold leading-7 tracking-tight text-neutral-700">
              Wallet Balance Reports for Tax, Audit, and Accounting
            </h1>
            <p className="mt-2 max-w-[660px] px-10 text-center text-base font-normal leading-5 text-neutral-700">
              Enter a wallet address, select token, and date to generate a downloadable balance
              report for tax filings, audits, and accounting.
            </p>
          </div>
        </header>

        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-neutral-700">
            <LoadingSpinner className="inline w-5 h-5 text-brand animate-spin" />
            <span>Loading…</span>
          </div>
        ) : !assetMap ? (
          // UX-display label resolution (not a silent data fallback): show
          // the real error message from the asset fetch when we have one,
          // otherwise the generic empty-state copy.
          <div className="py-12 text-neutral-700">{error ? error : "No assets available"}</div>
        ) : (
          <form
            className="w-full max-w-[660px] overflow-clip rounded-3xl bg-white"
            onSubmit={handleSubmit(onSubmit)}
          >
            <WalletAddressInput register={register} errors={errors} setValue={setValue} />

            <SectionRow title="Blockchain" variant="first" headingId={blockchainHeadingId} printHidden>
              <SegmentedControl<Blockchain>
                options={availableNetworks.map((n) => ({ value: n, label: blockchainLabel(n) }))}
                value={selectedNetwork}
                onChange={(value) => setValue("network", value)}
                ariaLabelledBy={blockchainHeadingId}
              />
            </SectionRow>

            <SectionRow title="Token" headingId={tokenHeadingId} printHidden>
              <TokenSelect
                options={selectedNetwork ? assetMap[selectedNetwork] ?? [] : []}
                value={selectedAsset}
                onChange={(value) => setValue("asset", value)}
                disabled={!selectedNetwork || (assetMap[selectedNetwork]?.length ?? 0) <= 1}
                ariaLabelledBy={tokenHeadingId}
              />
            </SectionRow>

            <SectionRow title="Balance Date" headingId={dateHeadingId}>
              <DateInput register={register} errors={errors} ariaLabelledBy={dateHeadingId} />
              <div className="mt-2 w-full">
                <SegmentedControl<Snapshot>
                  options={SNAPSHOTS.map((s) => ({ value: s, label: SNAPSHOT_LABEL[s] }))}
                  value={selectedSnapshot}
                  onChange={(value) => {
                    setSnapshotParamError(undefined);
                    setValue("snapshot", value);
                  }}
                  layout="equal"
                  ariaLabelledBy={dateHeadingId}
                  ariaDescribedBy={snapshotError ? `${snapshotHintId} ${snapshotErrorId}` : snapshotHintId}
                />
                <p id={snapshotHintId} className="mt-1 px-2.5 text-xs font-medium text-neutral-700">
                  Balance as of {SNAPSHOT_UTC_TIME[selectedSnapshot]} on the selected date.
                </p>
                {snapshotError && (
                  <p id={snapshotErrorId} className="mt-1 px-2.5 text-xs font-medium text-red-500">
                    {snapshotError}
                  </p>
                )}
              </div>
            </SectionRow>

            <SectionRow title="Currency" variant="last" headingId={currencyHeadingId} printHidden>
              <SegmentedControl<FormData["currency"]>
                options={CURRENCIES.map((c) => ({ value: c, label: c }))}
                value={selectedCurrency}
                onChange={(value) => setValue("currency", value)}
                layout="equal"
                ariaLabelledBy={currencyHeadingId}
              />
            </SectionRow>

            <div className="px-5 pb-5">
              <OutputPanel
                tokenName={submittedRequest ? submittedRequest.asset.name : (selectedAsset?.name ?? "")}
                balance={balance}
                prices={prices}
                currency={selectedCurrency}
                isFetching={isFetching}
                canSubmit={isValid && !visibleError && !snapshotError}
                onSubmit={handleSubmit(onSubmit)}
                onGeneratePdf={generatePDF}
                errorMessage={visibleError}
              />
            </div>
          </form>
        )}

        <p className="px-4 pb-8 text-center text-sm text-neutral-700">
          Example:{" "}
          <a
            href={`/?network=Ethereum&token=USDT&address=${EXAMPLE_ADDRESS}&date=${previousYearEnd()}&snapshot=end`}
            className="break-all rounded-sm text-brand-800 underline underline-offset-2 decoration-brand-800/50 hover:decoration-brand-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
          >
            {`/?network=Ethereum&token=USDT&address=${EXAMPLE_ADDRESS.slice(0, 6)}…&date=${previousYearEnd()}&snapshot=end`}
          </a>
        </p>
      </main>
      <Footer />
    </div>
  );
}

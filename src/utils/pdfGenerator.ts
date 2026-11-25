import { buildWalletBalancePdf, reportPriceFromQuote, type ReportParams } from "../core/pdf";
import type { PriceQuote } from "../core/price";
import type { Currency } from "../types";

interface BrowserReportParams {
  formData: ReportParams["formData"];
  balance: string | null;
  prices: PriceQuote | null;
  selectedCurrency: Currency;
}

// Browser entry point: builds the report (src/core/pdf.ts, shared with the
// headless CLI) and triggers the download. A report always carries balance
// and price; the button is disabled without them, and this guard keeps any
// other caller from producing an incomplete document.
export const generateWalletBalancePDF = async ({
  formData,
  balance,
  prices,
  selectedCurrency,
}: BrowserReportParams): Promise<void> => {
  if (balance === null || prices === null) {
    throw new Error("Fetch the balance and price before generating the PDF.");
  }
  const doc = await buildWalletBalancePdf({
    formData,
    balance,
    price: reportPriceFromQuote(prices, selectedCurrency),
  });
  // Filename keeps ISO YYYY-MM-DD because that's the right call for sortable
  // filenames; the on-page Date row uses Swiss formatting to match the form
  // input.
  doc.save(`wallet-balance-${formData.date}.pdf`);
};

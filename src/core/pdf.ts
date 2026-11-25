import { jsPDF } from "jspdf";
import type { Blockchain, Currency, Snapshot } from "../types";
import { formatSwissNumber } from "../utils/formatNumber";
import { formatSwissDecimal, multiplyToCents, numberToDecimalString } from "../utils/decimal";
import { blockchainLabel } from "../utils/blockchainLabel";
import { snapshotDescription } from "../utils/snapshot";
import { canonicalBitcoinAddress } from "../utils/bitcoinAddress";
import { brandSvgs, drawSvg } from "./logo";
import type { PriceCurrency, PriceQuote } from "./price";

// The one price the report is valued with.
interface ReportPriceBase {
  currency: Currency;
  // Price of one unit of the asset in `currency`.
  value: number;
  // Where the price comes from, printed in parentheses after it.
  source: string;
}

export type ReportPrice =
  | (ReportPriceBase & { supplied: false })
  // Given by the report creator, not looked up by LedgerReport; the PDF says
  // so in its own row. exactText is the validated input, printed unchanged
  // so the value row can be recomputed from the printed price.
  | (ReportPriceBase & { supplied: true; exactText: string });

// The report value: balance × price computed exactly in decimal and rounded
// once, half-up, to 2 decimals ("1862299.98"). The PDF, summary.csv and
// stdout all use this one result. A supplied price enters as its exact text,
// a looked-up price as the decimal expansion of its number.
export function reportValue(balance: string, price: ReportPrice): string {
  return multiplyToCents(balance, price.supplied ? price.exactText : numberToDecimalString(price.value));
}

// The looked-up price for the chosen currency.
export function reportPriceFromQuote(quote: PriceQuote, currency: Currency): ReportPrice {
  const key = currency.toLowerCase() as PriceCurrency;
  return { currency, value: quote[key], source: quote.source[key], supplied: false };
}

// Builds the wallet balance report. Framework- and DOM-free: the browser
// saves the returned document via jsPDF's download, the headless CLI writes
// doc.output("arraybuffer") to disk.

// The report never shows the plain address, only the first 16 hex chars of
// its SHA-256 — intentional, for privacy. The CLI summary uses the same value.
// An all-uppercase bech32 address is hashed in its lowercase form, so both
// spellings of one wallet give the same hash; lowercase bech32 (the usual
// spelling), Base58 and EVM addresses are hashed exactly as entered.
export async function addressHashForReport(address: string): Promise<string> {
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalBitcoinAddress(address)),
  );
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .substring(0, 16);
}

export interface ReportParams {
  formData: {
    date: string;
    snapshot: Snapshot;
    // The network printed is the asset's own chain, the one balance and
    // price were read on, never a separately selected network.
    asset: { name: string; blockchain: Blockchain };
    address: string;
  };
  balance: string;
  price: ReportPrice;
}

// Enough digits to read small token prices (0.0006459) without drowning
// large ones (69'571.9885): 4 decimals, or 4 significant digits below 1.
function formatPrice(price: number): string {
  const decimals = price >= 1 ? 4 : Math.max(4, 3 - Math.floor(Math.log10(price)));
  return formatSwissNumber(price, decimals);
}

export async function buildWalletBalancePdf({
  formData,
  balance,
  price,
}: ReportParams): Promise<jsPDF> {
  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();

  // Render the LedgerReport brand: logomark on the left, wordmark on the
  // right, centred together at the top of the page, drawn as vector paths
  // from the same SVGs the web page shows (see ./logo.ts).
  //
  // No try/catch around the brand: a tax-grade artifact without
  // identification is exactly the kind of degraded result the
  // no-silent-degradation rule forbids. If drawing fails the throw bubbles
  // up to the caller and surfaces as an error.
  const { logomark, wordmark } = brandSvgs();

  // Target PDF dimensions (mm). The wordmark drives the visual height;
  // the logomark matches its height and computes its width from aspect.
  const wordmarkHeightMm = 10;
  const wordmarkWidthMm = wordmarkHeightMm * (wordmark.viewBoxWidth / wordmark.viewBoxHeight);
  const logomarkHeightMm = 12;
  const logomarkWidthMm = logomarkHeightMm * (logomark.viewBoxWidth / logomark.viewBoxHeight);
  const gapMm = 4;

  const totalWidthMm = logomarkWidthMm + gapMm + wordmarkWidthMm;
  const startX = (pageWidth - totalWidthMm) / 2;
  const brandTopY = 28;
  // The wordmark sits at the same optical centre as the logomark.
  const wordmarkY = brandTopY + (logomarkHeightMm - wordmarkHeightMm) / 2;

  drawSvg(doc, logomark, startX, brandTopY, logomarkWidthMm);
  drawSvg(doc, wordmark, startX + logomarkWidthMm + gapMm, wordmarkY, wordmarkWidthMm);
  doc.setFillColor(0, 0, 0);

  // Add title left-aligned below the brand strip.
  const titleY = brandTopY + logomarkHeightMm + 16;
  doc.setFontSize(20);
  doc.text("Wallet Balance Report for Tax, Audit, and Accounting", 20, titleY);

  // Derive the data block's top edge from the title so the layout stays
  // compact instead of leaving a hardcoded ~5cm dead band between brand and
  // data. The 8mm offset puts the rule a comfortable distance below the
  // descender line of the title text.
  const startY = titleY + 8;

  // Add horizontal line above data section
  doc.setLineWidth(0.5);
  doc.line(20, startY, pageWidth - 20, startY);

  // Layout: a running Y cursor that advances per row. Adding or removing
  // rows here is a single insertion — no need to recompute every following
  // offset.
  const labelX = 20;      // X position for labels
  const valueX = 60;      // X position for values (aligned column)
  const rowGap = 10;      // vertical distance between successive rows
  let y = startY + 12.5;

  doc.setFontSize(12);
  doc.setFont("helvetica", "normal");

  // Render the snapshot date in Swiss DD.MM.YYYY so it matches the on-screen
  // input format (the date input renders in user locale, de-CH being the
  // primary audience). Parsed by hand from the ISO string to stay
  // locale-independent on the Node-built test path.
  const [isoY, isoM, isoD] = formData.date.split("-");
  const dateSwiss = `${isoD}.${isoM}.${isoY}`;

  // Print labels and values separately for perfect alignment. No silent
  // "Not specified" fallbacks: by the time canGeneratePdf gates this call,
  // every field below is populated. A future refactor that makes one
  // optional should surface a thrown error, not paper a placeholder into a
  // tax document.
  doc.text("Date:", labelX, y);
  doc.text(dateSwiss, valueX, y);
  y += rowGap;

  // The calendar day alone is ambiguous: state which instant of it (UTC)
  // the balance refers to.
  doc.text("Snapshot:", labelX, y);
  doc.text(snapshotDescription(formData.snapshot), valueX, y);
  y += rowGap;

  doc.text("Network:", labelX, y);
  doc.text(blockchainLabel(formData.asset.blockchain), valueX, y);
  y += rowGap;

  doc.text("Token:", labelX, y);
  doc.text(formData.asset.name, valueX, y);
  y += rowGap;

  // Hash the address for privacy
  const addressHash = await addressHashForReport(formData.address);
  doc.text("Address Hash:", labelX, y);
  doc.text(addressHash, valueX, y);
  y += rowGap * 2; // extra spacer before the balance block

  doc.setFont("helvetica", "bold");
  doc.text("Balance:", labelX, y);
  doc.text(`${balance} ${formData.asset.name}`, valueX, y);
  doc.setFont("helvetica", "normal");
  y += rowGap;

  // State exactly which price was used and where it comes from, then the
  // value. Long notes wrap within the value column.
  const valueWidth = pageWidth - 20 - valueX;
  const wrappedRow = (label: string, text: string) => {
    const lines: string[] = doc.splitTextToSize(text, valueWidth);
    doc.text(label, labelX, y);
    doc.text(lines, valueX, y);
    y += rowGap + (lines.length - 1) * 5;
  };
  wrappedRow(
    "Price:",
    `${price.currency} ${price.supplied ? price.exactText : formatPrice(price.value)} per ${formData.asset.name} (${price.source})`,
  );
  if (price.supplied) {
    wrappedRow("Price source:", "Provided by the report creator — not fetched or verified by LedgerReport.");
  }

  doc.text(`In ${price.currency}:`, labelX, y);
  doc.text(formatSwissDecimal(reportValue(balance, price)), valueX, y);
  y += rowGap;

  // Add horizontal line below data section
  doc.line(20, y, pageWidth - 20, y);

  // Add footer at the bottom of the page
  const pageHeight = doc.internal.pageSize.getHeight();
  doc.setFontSize(10);
  doc.setTextColor(0, 0, 0); // Reset to black

  // Local-time YYYY-MM-DD HH:MM:SS — free of locale-specific separators.
  // Single-user PDF, so local time is the right reference frame for the
  // reader.
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  const generatedOn =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  doc.text("Generated with LedgerReport.com — Wallet Balance Reports for Tax, Audit, and Accounting", 20, pageHeight - 20);
  doc.text(`Generated on: ${generatedOn}`, 20, pageHeight - 15);

  return doc;
}

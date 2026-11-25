import type { jsPDF } from "jspdf";
import logomarkSvg from "../../public/assets/logo-logomark.svg?raw";
import wordmarkSvg from "../../public/assets/logo-wordmark.svg?raw";

// Draws the brand SVGs as vector paths straight into the PDF. This needs no
// DOM or canvas, so the browser and the headless CLI render the identical
// logo from the same source files the web page shows. Only the subset of SVG
// the logo files use is supported (absolute M/L/H/V/C/Z on <path> with a
// solid fill); anything else throws so a changed logo cannot render wrong
// silently.

interface ParsedPath {
  d: string;
  rgb: [number, number, number];
}

export interface ParsedSvg {
  viewBoxWidth: number;
  viewBoxHeight: number;
  paths: ParsedPath[];
}

function parseHexColor(hex: string): [number, number, number] {
  const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex);
  if (!m) throw new Error(`Logo SVG: unsupported colour ${hex}`);
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

export function parseSvg(svg: string): ParsedSvg {
  const viewBox = /viewBox="([^"]+)"/.exec(svg);
  if (!viewBox) throw new Error("Logo SVG: missing viewBox");
  const box = viewBox[1].trim().split(/[\s,]+/).map(Number);
  if (box.length !== 4 || box.some((n) => !Number.isFinite(n)) || box[0] !== 0 || box[1] !== 0) {
    throw new Error(`Logo SVG: unsupported viewBox "${viewBox[1]}"`);
  }

  const paths: ParsedPath[] = [];
  for (const match of svg.matchAll(/<path\b([^>]*)\/?>/g)) {
    const attrs = match[1];
    const d = /\sd="([^"]+)"/.exec(attrs);
    if (!d) throw new Error("Logo SVG: <path> without d");
    // Figma exports fills as `var(--fill-0, #RRGGBB)`; the fallback is the
    // colour the browser renders.
    const fill = /\sfill="(?:var\([^,]+,\s*)?(#[0-9a-fA-F]{6})\)?"/.exec(attrs);
    if (!fill) throw new Error("Logo SVG: <path> without a solid fill");
    if (/\b(fill-rule|transform|stroke)=/.test(attrs)) {
      throw new Error("Logo SVG: unsupported <path> attribute");
    }
    paths.push({ d: d[1], rgb: parseHexColor(fill[1]) });
  }
  if (paths.length === 0) throw new Error("Logo SVG: no paths");
  return { viewBoxWidth: box[2], viewBoxHeight: box[3], paths };
}

// Emits one SVG path into the current jsPDF path, scaled and offset into mm.
function tracePath(doc: jsPDF, d: string, x0: number, y0: number, scale: number): void {
  const tokens = d.match(/[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g);
  if (!tokens) throw new Error("Logo SVG: empty path");

  let i = 0;
  let command = "";
  let cx = 0;
  let cy = 0;
  const X = (v: number) => x0 + v * scale;
  const Y = (v: number) => y0 + v * scale;
  const num = (): number => {
    const token = tokens[i++];
    const value = Number(token);
    if (token === undefined || !Number.isFinite(value)) throw new Error("Logo SVG: malformed path data");
    return value;
  };
  const nextIsNumber = () => i < tokens.length && !/^[A-Za-z]$/.test(tokens[i]);

  while (i < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[i])) {
      command = tokens[i++];
    } else if (command === "" || command === "Z") {
      throw new Error("Logo SVG: path data must start with a command");
    }
    switch (command) {
      case "M":
        cx = num();
        cy = num();
        doc.moveTo(X(cx), Y(cy));
        // Further coordinate pairs after M are implicit L commands.
        command = "L";
        break;
      case "L":
        cx = num();
        cy = num();
        doc.lineTo(X(cx), Y(cy));
        break;
      case "H":
        cx = num();
        doc.lineTo(X(cx), Y(cy));
        break;
      case "V":
        cy = num();
        doc.lineTo(X(cx), Y(cy));
        break;
      case "C": {
        const x1 = num();
        const y1 = num();
        const x2 = num();
        const y2 = num();
        cx = num();
        cy = num();
        doc.curveTo(X(x1), Y(y1), X(x2), Y(y2), X(cx), Y(cy));
        break;
      }
      case "Z":
        doc.close();
        if (nextIsNumber()) throw new Error("Logo SVG: numbers after Z");
        break;
      default:
        throw new Error(`Logo SVG: unsupported path command "${command}"`);
    }
  }
}

// Draws the SVG so its viewBox fills `width` mm (height follows the aspect
// ratio), top-left corner at (x, y).
export function drawSvg(doc: jsPDF, svg: ParsedSvg, x: number, y: number, width: number): void {
  const scale = width / svg.viewBoxWidth;
  for (const path of svg.paths) {
    doc.setFillColor(path.rgb[0], path.rgb[1], path.rgb[2]);
    tracePath(doc, path.d, x, y, scale);
    // Non-zero winding, the SVG default fill rule.
    doc.fill();
  }
}

// Parsed on use rather than at import, so a broken logo surfaces as a PDF
// generation error instead of breaking the whole page load.
export function brandSvgs(): { logomark: ParsedSvg; wordmark: ParsedSvg } {
  return { logomark: parseSvg(logomarkSvg), wordmark: parseSvg(wordmarkSvg) };
}

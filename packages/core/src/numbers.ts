// Numbers → spoken English words.
// Numbers are expanded here (not left to the TTS engine) so that one source
// token yields a known list of spoken words — this keeps word timings aligned.

const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALES = ["", "thousand", "million", "billion", "trillion"];

function below1000(n: number): string[] {
  const out: string[] = [];
  const h = Math.floor(n / 100);
  const r = n % 100;
  if (h) out.push(ONES[h]!, "hundred");
  if (r) {
    if (r < 20) out.push(ONES[r]!);
    else out.push(TENS[Math.floor(r / 10)]! + (r % 10 ? `-${ONES[r % 10]}` : ""));
  }
  return out;
}

/** Non-negative integer string → words. Very long integers are read digit by digit. */
export function integerToWords(digits: string): string[] {
  if (/^0\d/.test(digits)) return digitsToWords(digits); // "022" → zero two two
  if (digits.length > 15) return digitsToWords(digits);
  let n = Number(digits);
  if (n === 0) return ["zero"];
  const groups: number[] = [];
  while (n > 0) {
    groups.push(n % 1000);
    n = Math.floor(n / 1000);
  }
  const out: string[] = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i]!;
    if (!g) continue;
    out.push(...below1000(g));
    if (SCALES[i]) out.push(SCALES[i]!);
  }
  return out;
}

export function digitsToWords(digits: string): string[] {
  return [...digits].filter((c) => /\d/.test(c)).map((d) => ONES[Number(d)]!);
}

/** 1900–2099 read as a year: "nineteen ninety-nine", "twenty seventeen", "two thousand seven". */
export function yearToWords(y: number): string[] {
  if (y >= 2000 && y <= 2009) return integerToWords(String(y));
  const hi = Math.floor(y / 100);
  const lo = y % 100;
  if (lo === 0) return [...below1000(hi), "hundred"];
  return [...below1000(hi), ...(lo < 10 ? ["oh", ONES[lo]!] : below1000(lo))];
}

export interface NumberOptions {
  /** Max significant digits for decimals; more are rounded and prefixed with "about". */
  maxDigits: number;
}

const NUMBER_RE = /^([-−]?)(\d{1,3}(?:,\d{3})+|\d+)?(?:\.(\d+))?(%?)$/;

export function isNumberToken(s: string): boolean {
  const m = NUMBER_RE.exec(s);
  return !!m && (m[2] !== undefined || m[3] !== undefined);
}

/** Spoken words for a numeric token like "1,024", "-0.5", "0.99999952", "12%", "2017". */
export function numberToWords(token: string, opts: NumberOptions, allowYear = true): string[] {
  const m = NUMBER_RE.exec(token);
  if (!m || (m[2] === undefined && m[3] === undefined)) return [token];
  const [, sign, intRaw = "0", fracRaw, pct] = m;
  const intPart = intRaw.replace(/,/g, "");
  const out: string[] = [];
  if (sign) out.push("minus");

  if (fracRaw === undefined) {
    const n = Number(intPart);
    if (allowYear && !sign && !pct && intRaw.length === 4 && n >= 1900 && n <= 2099) {
      out.push(...yearToWords(n));
    } else {
      out.push(...integerToWords(intPart));
    }
  } else {
    // long runs of trailing zeros carry no meaning when spoken: 0.00000000 → zero
    let frac = fracRaw.length > opts.maxDigits ? fracRaw.replace(/0+$/, "") : fracRaw;
    let int = intPart;
    const sig = (int.replace(/^0+/, "") + frac).replace(/^0+/, "").length;
    if (sig > opts.maxDigits && frac) {
      const rounded = Number(`${int}.${frac}`).toPrecision(opts.maxDigits);
      const asNum = Number(rounded);
      out.push("about");
      if (/e/i.test(String(asNum))) {
        // tiny/huge: mantissa times ten to the power
        const [mant, exp] = asNum.toExponential().split("e");
        const [mi, mf] = mant!.split(".");
        out.push(...integerToWords(mi!));
        if (mf) out.push("point", ...digitsToWords(mf));
        out.push("times", "ten", "to", "the");
        const e = Number(exp);
        if (e < 0) out.push("minus");
        out.push(...integerToWords(String(Math.abs(e))));
        if (pct) out.push("percent");
        return out;
      }
      const s = String(asNum);
      [int, frac = ""] = s.split(".") as [string, string?];
    }
    out.push(...integerToWords(int || "0"));
    if (frac) out.push("point", ...digitsToWords(frac));
  }
  if (pct) out.push("percent");
  return out;
}

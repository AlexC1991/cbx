/**
 * The colours cbx prints in, on their own so the quickest paths (bin.ts)
 * can print exactly what the full commands print without loading them.
 */
const ESC = String.fromCharCode(27);
const paint = (code: string) => (value: string) => `${ESC}[${code}m${value}${ESC}[0m`;
export const dim = paint("2");
export const bold = paint("1");
export const red = paint("31");
export const green = paint("32");
export const accent = paint("33");

export const short = (id: string) => id.slice(0, 10);

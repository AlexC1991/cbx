/*
  Colour for the command modules, on the same terms as cli.ts: only at a
  terminal, and never when NO_COLOR is set. Each module used to carry its own
  always-on copy, so output piped to a file, or a script asking for plain
  text, still came back full of escape codes.
*/
const colour = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code: string) => (text: string) =>
  colour ? `[${code}m${text}[0m` : text;

export const dim = paint("2");
export const bold = paint("1");
export const red = paint("31");
export const green = paint("32");
export const accent = paint("33");

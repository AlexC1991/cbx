/**
 * Where a client gets its service address and bearer token.
 *
 * The upload and download engines are shared by the desktop application and
 * the command-line tool, which keep credentials in completely different
 * places — an operating-system vault in one, a file under the home directory
 * in the other. Injecting this keeps the engines free of either.
 */
export type Credentials = {
  /** The API origin, without a trailing slash. */
  origin(): string;
  /** The bearer token, or an empty string when signed out. */
  token(): Promise<string>;
};

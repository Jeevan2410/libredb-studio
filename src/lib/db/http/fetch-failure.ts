/**
 * Why a request to an HTTP-speaking engine never got an answer, in the user's terms (#1431).
 *
 * Node's `fetch` reports every network failure as `TypeError: fetch failed` and keeps the reason in
 * `cause`: `{ code: "ECONNREFUSED", address, port }`, or an `AggregateError` with one entry per
 * address tried (`::1` and `127.0.0.1` for `localhost`). Bun puts the code on the error itself
 * (`ConnectionRefused`, `ENOTFOUND`) and names no address. A raw `http.request` error carries the
 * code and address directly. Reading only `error.message` made a wrong port, a stopped container and
 * an unknown host all read "fetch failed". Measured 2026-10-07 on Node 24.18 and Bun 1.4.2.
 */
import { isTlsFailureCode } from "./node-transport";

const REFUSED: ReadonlySet<string> = new Set(["ECONNREFUSED", "ConnectionRefused"]);
const NOT_FOUND: ReadonlySet<string> = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_NONAME"]);
const TIMED_OUT: ReadonlySet<string> = new Set(["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"]);
const RESET: ReadonlySet<string> = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "ConnectionClosed"]);

/** A runtime error code: Node's `ECONNREFUSED` style and Bun's `ConnectionRefused` style. */
const ERROR_CODE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

interface Failure {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly address?: unknown;
  readonly port?: unknown;
  readonly hostname?: unknown;
  readonly errors?: unknown;
  readonly cause?: unknown;
}

function asFailure(value: unknown): Failure | undefined {
  return typeof value === "object" && value !== null ? (value as Failure) : undefined;
}

function codeOf(failure: Failure | undefined): string | undefined {
  const code = failure?.code;
  return typeof code === "string" && ERROR_CODE.test(code) ? code : undefined;
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** `host:port`, bracketing an IPv6 address. */
function endpoint(failure: Failure): string | undefined {
  const address = textOf(failure.address);
  if (address === undefined) return undefined;
  const host = address.includes(":") ? `[${address}]` : address;
  return typeof failure.port === "number" ? `${host}:${String(failure.port)}` : host;
}

/** Every address the runtime named, or the request's own `host:port` when it named none. */
function addressesOf(failure: Failure, target: URL): string {
  const named = [failure, ...(Array.isArray(failure.errors) ? failure.errors : [])]
    .map((entry) => asFailure(entry))
    .flatMap((entry) => (entry === undefined ? [] : [endpoint(entry)]))
    .filter((address): address is string => address !== undefined);
  const unique = [...new Set(named)];
  return unique.length > 0 ? unique.join(" and ") : target.host;
}

/** The error, its cause, or its cause's cause: whichever first carries a code. */
function failureWithCode(error: unknown): { failure: Failure; code: string } | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current !== undefined; depth++) {
    const failure = asFailure(current);
    const code = codeOf(failure);
    if (failure !== undefined && code !== undefined) return { failure, code };
    current = failure?.cause;
  }
  return undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The reason a request to `url` failed, as a sentence fragment a transport prefixes with its own
 * "<Engine> request failed: ". Falls back to the error's message, and its cause's, when the runtime
 * names no code it can read.
 */
export function describeFetchFailure(error: unknown, url: string): string {
  // A deadline or a cancellation keeps the runtime's own words: the providers' error mapping reads
  // them to classify a timeout, and they were never the "fetch failed" this function replaces.
  if (error instanceof DOMException) return error.message;
  const target = new URL(url);
  const found = failureWithCode(error);
  if (found === undefined) {
    const cause = textOf(asFailure(asFailure(error)?.cause)?.message);
    return cause === undefined ? messageOf(error) : `${messageOf(error)}: ${cause}`;
  }
  const { failure, code } = found;
  if (REFUSED.has(code)) return `connection refused at ${addressesOf(failure, target)}`;
  if (NOT_FOUND.has(code)) return `host ${textOf(failure.hostname) ?? target.hostname} not found (${code})`;
  if (TIMED_OUT.has(code)) return `connection to ${addressesOf(failure, target)} timed out (${code})`;
  if (RESET.has(code)) return `connection to ${addressesOf(failure, target)} was reset (${code})`;
  if (isTlsFailureCode(code)) {
    const reason = textOf(failure.message);
    return `TLS connection to ${target.host} failed (${code}${reason === undefined ? "" : `: ${reason}`})`;
  }
  return `${textOf(failure.message) ?? messageOf(error)} (${code})`;
}

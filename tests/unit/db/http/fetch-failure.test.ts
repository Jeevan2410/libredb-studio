/**
 * #1431: the HTTP transports built their network error from `err.message` alone, which on Node's
 * fetch is always "fetch failed", so a wrong port, a stopped container and an unknown host read the
 * same. The shapes below are the ones measured on Node 24.18 and Bun 1.4.2 on 2026-10-07.
 */
import { describe, expect, test } from "bun:test";
import { describeFetchFailure } from "@/lib/db/http/fetch-failure";

const URL_8123 = "http://localhost:8123/";

/** What Node's fetch throws: a TypeError whose cause carries the code. */
function nodeFetchFailure(cause: Record<string, unknown>): TypeError {
  return new TypeError("fetch failed", { cause });
}

/** What Bun's fetch throws: the code on the error itself, with no address. */
function bunFetchFailure(message: string, code: string): TypeError {
  return Object.assign(new TypeError(message), { code });
}

describe("describeFetchFailure", () => {
  test("Node: a refused connection names the address it dialled", () => {
    const error = nodeFetchFailure({
      code: "ECONNREFUSED",
      message: "connect ECONNREFUSED 127.0.0.1:24199",
      address: "127.0.0.1",
      port: 24199,
    });
    expect(describeFetchFailure(error, "http://127.0.0.1:24199/")).toBe("connection refused at 127.0.0.1:24199");
  });

  test("Node: localhost refused on both families names both addresses, IPv6 bracketed", () => {
    const cause = Object.assign(new AggregateError([], ""), {
      code: "ECONNREFUSED",
      errors: [
        { code: "ECONNREFUSED", address: "::1", port: 24199 },
        { code: "ECONNREFUSED", address: "127.0.0.1", port: 24199 },
      ],
    });
    expect(describeFetchFailure(new TypeError("fetch failed", { cause }), "http://localhost:24199/")).toBe(
      "connection refused at [::1]:24199 and 127.0.0.1:24199",
    );
  });

  test("Bun: a refused connection names the request's own host and port", () => {
    const error = bunFetchFailure("Unable to connect. Is the computer able to access the url?", "ConnectionRefused");
    expect(describeFetchFailure(error, URL_8123)).toBe("connection refused at localhost:8123");
  });

  test("an unknown host reads differently from a refusal, on both runtimes", () => {
    const node = nodeFetchFailure({
      code: "ENOTFOUND",
      message: "getaddrinfo ENOTFOUND no-such-host.invalid",
      hostname: "no-such-host.invalid",
    });
    const bun = bunFetchFailure("getaddrinfo ENOTFOUND no-such-host.invalid", "ENOTFOUND");
    const url = "http://no-such-host.invalid:8123/";
    expect(describeFetchFailure(node, url)).toBe("host no-such-host.invalid not found (ENOTFOUND)");
    expect(describeFetchFailure(bun, url)).toBe("host no-such-host.invalid not found (ENOTFOUND)");
  });

  test("a connect timeout and a reset read differently from a refusal", () => {
    const timedOut = nodeFetchFailure({ code: "ETIMEDOUT", address: "10.0.0.5", port: 8123 });
    const reset = nodeFetchFailure({ code: "ECONNRESET", address: "10.0.0.5", port: 8123 });
    expect(describeFetchFailure(timedOut, URL_8123)).toBe("connection to 10.0.0.5:8123 timed out (ETIMEDOUT)");
    expect(describeFetchFailure(reset, URL_8123)).toBe("connection to 10.0.0.5:8123 was reset (ECONNRESET)");
  });

  test("a TLS failure keeps the certificate reason", () => {
    const error = nodeFetchFailure({ code: "SELF_SIGNED_CERT_IN_CHAIN", message: "self-signed certificate in chain" });
    expect(describeFetchFailure(error, "https://db.example.com:8443/")).toBe(
      "TLS connection to db.example.com:8443 failed (SELF_SIGNED_CERT_IN_CHAIN: self-signed certificate in chain)",
    );
  });

  test("a raw http.request error carries the code on the error itself", () => {
    const error = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8091"), {
      code: "ECONNREFUSED",
      address: "127.0.0.1",
      port: 8091,
    });
    expect(describeFetchFailure(error, "http://127.0.0.1:8091/")).toBe("connection refused at 127.0.0.1:8091");
  });

  test("any other code keeps the runtime's message beside it", () => {
    const error = nodeFetchFailure({ code: "EHOSTUNREACH", message: "connect EHOSTUNREACH 10.0.0.9:8123" });
    expect(describeFetchFailure(error, URL_8123)).toBe("connect EHOSTUNREACH 10.0.0.9:8123 (EHOSTUNREACH)");
  });

  test("with no code anywhere, the message stands, with the cause's when there is one", () => {
    expect(describeFetchFailure(new Error("fetch failed"), URL_8123)).toBe("fetch failed");
    expect(
      describeFetchFailure(new TypeError("fetch failed", { cause: new Error("other side closed") }), URL_8123),
    ).toBe("fetch failed: other side closed");
    expect(describeFetchFailure("boom", URL_8123)).toBe("boom");
  });

  test("a deadline or a cancellation keeps the runtime's own words", () => {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const abort = new DOMException("This operation was aborted", "AbortError");
    expect(describeFetchFailure(timeout, URL_8123)).toBe("The operation was aborted due to timeout");
    expect(describeFetchFailure(abort, URL_8123)).toBe("This operation was aborted");
  });
});

/**
 * HTTP calls on a server under test. Each answer is read whole, so a case
 * asserts on the status, a header, the text or the parsed JSON without
 * juggling a stream.
 */

export interface HttpAnswer {
  status: number;
  headers: Headers;
  text: string;
  /** The body parsed as JSON; throws, naming the route, when it is not JSON. */
  json<T = unknown>(): T;
}

export interface Http {
  get(path: string): Promise<HttpAnswer>;
  post(path: string, body?: unknown): Promise<HttpAnswer>;
  put(path: string, body?: unknown): Promise<HttpAnswer>;
  /** Any method, with an optional JSON body. */
  call(method: string, path: string, body?: unknown): Promise<HttpAnswer>;
}

export function http(base: string): Http {
  const call = async (method: string, path: string, body?: unknown): Promise<HttpAnswer> => {
    const response = await fetch(`${base}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      text,
      json<T>() {
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new Error(`${method} ${path} answered ${response.status} with a body that is not JSON: ${text.slice(0, 200)}`);
        }
      },
    };
  };
  return {
    get: (path) => call("GET", path),
    post: (path, body) => call("POST", path, body),
    put: (path, body) => call("PUT", path, body),
    call,
  };
}

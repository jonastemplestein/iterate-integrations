import { RpcTarget } from "cloudflare:workers";
import { WaitroseApi } from "./client.js";

export * from "./client.js";
export { exchange, EXCHANGE_SOURCE } from "./exchange.js";

type WaitroseMethods = { [Method in keyof WaitroseApi]: WaitroseApi[Method] };
export interface Waitrose extends WaitroseMethods {}

/** THE WAITROSE API AS A CAP'N WEB RPC TARGET: every method of `WaitroseApi` (search, trolley,
 *  orders, slots, checkout) is a method of this object, so it can be called in a script, or served
 *  from a config worker with `newWorkersRpcResponse(request, new Waitrose({ fetch }))` and dialled
 *  from anywhere (`itx.connectToCapnweb(url)`).
 *
 *  `fetch` is `itx.fetch`: the token never enters this code. The requests carry
 *  `Bearer getSecret("<secret>", { field: "accessToken" })`, which egress swaps for the real token
 *  toward the secret's pinned origin (www.waitrose.com) and re-mints by the secret's exchange
 *  (`exchange.ts`) when Waitrose answers 401. `placeOrder` spends money: it places the order in the
 *  account's current trolley, after `getCheckout` review and only for the total the caller passes. */
export class Waitrose extends RpcTarget {
  readonly #api: WaitroseApi;

  constructor(options: { fetch: (request: Request) => Promise<Response>; secret?: string }) {
    super();
    const secret = options.secret ?? "/secrets/waitrose";
    this.#api = new WaitroseApi({
      fetch: (input, init) => options.fetch(new Request(input, init)),
      authorization: `Bearer getSecret(${JSON.stringify(secret)}, { field: "accessToken" })`,
    });
  }

  static {
    // Cap'n Web serves an RpcTarget's PROTOTYPE methods only, so each of the API's is defined here
    // once. The indexing is untyped because the method names come from the class at runtime; the
    // `Waitrose` interface above is what callers see.
    for (const name of Object.getOwnPropertyNames(WaitroseApi.prototype)) {
      if (name === "constructor") continue;
      Object.defineProperty(Waitrose.prototype, name, {
        value(this: Waitrose, ...args: unknown[]) {
          return (this.#api as unknown as Record<string, (...args: unknown[]) => unknown>)[name](
            ...args,
          );
        },
        writable: true,
        configurable: true,
      });
    }
  }
}

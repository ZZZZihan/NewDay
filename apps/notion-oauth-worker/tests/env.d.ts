import type { Env } from "../src/index";

declare module "cloudflare:workers" {
  // Cloudflare's test runtime discovers binding types through this interface.
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface ProvidedEnv extends Env {}
}

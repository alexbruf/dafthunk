import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const emptyStub = resolve(__dirname, "test/stubs/empty-module.ts");

/**
 * Config for the generator benchmark alone.
 *
 * It cannot use vitest.integration.config.mts. That config has no module
 * aliases, and the benchmark is the only test in either tier that loads the
 * real `CloudflareNodeRegistry` — which transitively pulls in packages workerd
 * cannot resolve (`@cf-wasm/*`, `twilio`, `@cloudflare/sandbox`). The pool then
 * dies during startup with "Worker exited unexpectedly", before a single case
 * runs and with no indication of why. The template integration specs are
 * unaffected because they import individual node classes rather than the
 * registry.
 *
 * So the aliases below are copied from vitest.config.mts. It also points at
 * wrangler.test.jsonc rather than wrangler.integration.jsonc: the benchmark
 * never touches the Workers AI binding, and avoiding the remote binding means
 * a benchmark run against OpenRouter needs no Cloudflare credentials at all.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@cloudflare/sandbox": emptyStub,
      "@cloudflare/containers": emptyStub,
      "@cf-wasm/photon": emptyStub,
      "@cf-wasm/png": emptyStub,
      "@cf-wasm/resvg": emptyStub,
      twilio: emptyStub,
    },
  },
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./wrangler.test.jsonc",
      },
    }),
  ],
  test: {
    include: ["**/benchmark.integration.ts"],
    setupFiles: ["./test/setup.ts"],
    testTimeout: 180000,
  },
});

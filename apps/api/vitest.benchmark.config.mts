import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const emptyStub = resolve(__dirname, "test/stubs/empty-module.ts");

/**
 * Real value when the environment supplies one, placeholder otherwise.
 *
 * `checkGeneratorPreconditions` refuses to run without the AI Gateway settings,
 * and the benchmark's OpenRouter mode never uses them because it overrides the
 * model call outright. Passing the environment's value through first matters:
 * a binding that unconditionally won would silently redirect a gateway-mode run
 * to a placeholder account and the failure would look like a broken deployment.
 */
const passthrough = (name: string, fallback: string) =>
  process.env[name] || fallback;

/**
 * Config for the generator benchmark alone.
 *
 * It cannot use vitest.integration.config.mts. That config declares no module
 * aliases, and the benchmark is the only test in either tier that loads the
 * real `CloudflareNodeRegistry` — which transitively pulls in packages workerd
 * cannot resolve (`@cf-wasm/*`, `twilio`, `@cloudflare/sandbox`). The pool then
 * dies during startup with "Worker exited unexpectedly", before a single case
 * runs and with no indication of why. The template integration specs are
 * unaffected because they import individual node classes, not the registry.
 *
 * It points at wrangler.test.jsonc rather than wrangler.integration.jsonc: the
 * benchmark never touches the Workers AI binding, so avoiding the remote
 * binding means a run against OpenRouter needs no Cloudflare credentials.
 *
 * D1 migrations are read here and applied in the setup file, because the
 * benchmark drives `generateWorkflow`, which reads billing rows and writes a
 * workflow — both against the local, Miniflare-backed D1 and R2.
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
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(
        resolve(__dirname, "src/db/migrations")
      );
      return {
        wrangler: { configPath: "./wrangler.test.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            CLOUDFLARE_ACCOUNT_ID: passthrough(
              "CLOUDFLARE_ACCOUNT_ID",
              "benchmark-placeholder"
            ),
            CLOUDFLARE_AI_GATEWAY_ID: passthrough(
              "CLOUDFLARE_AI_GATEWAY_ID",
              "benchmark-placeholder"
            ),
            CLOUDFLARE_API_TOKEN: passthrough(
              "CLOUDFLARE_API_TOKEN",
              "benchmark-placeholder"
            ),
          },
        },
      };
    }),
  ],
  test: {
    include: ["**/benchmark.integration.ts"],
    setupFiles: ["./test/setup.ts", "./test/benchmark-setup.ts"],
    testTimeout: 180000,
  },
});

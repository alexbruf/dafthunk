import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll } from "vitest";

/**
 * Prepares local D1 for the generator benchmark.
 *
 * The benchmark drives `generateWorkflow`, which reads the organization's
 * billing row before it will call a model and writes a workflow afterwards. The
 * test pool's D1 starts with no schema — the reason the repo's other route
 * tests avoid the database entirely — so migrations are applied here and one
 * organization is seeded.
 *
 * Everything is local: Miniflare backs D1 and R2, so this needs no Cloudflare
 * account.
 */

/** Shared with benchmark.integration.ts, which generates on this org's behalf. */
export const BENCHMARK_ORGANIZATION_ID = "benchmark-org";
export const BENCHMARK_USER_ID = "benchmark-user";

// `cloudflare:test`'s ambient Env carries neither the D1 binding from
// wrangler.test.jsonc nor the migrations binding this config adds, so the shape
// is narrowed here rather than widening the shared ProvidedEnv declaration.
interface BenchmarkTestEnv {
  DB: D1Database;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

beforeAll(async () => {
  const { DB, TEST_MIGRATIONS } = env as unknown as BenchmarkTestEnv;
  await applyD1Migrations(DB, TEST_MIGRATIONS);

  // Credits present and not exhausted, so the run is never gated on billing.
  // The plan is deliberately left to resolve from CLOUDFLARE_ENV: outside
  // production that yields "pro", which is the same catalog the benchmark
  // pinned when it called the pipeline directly, so the numbers stay
  // comparable across the change.
  await DB.prepare(
    `INSERT OR REPLACE INTO organizations
       (id, name, compute_credits, unlimited_usage, credits_exhausted)
     VALUES (?, ?, ?, 0, 0)`
  )
    .bind(BENCHMARK_ORGANIZATION_ID, "Benchmark Org", 1_000_000)
    .run();
});

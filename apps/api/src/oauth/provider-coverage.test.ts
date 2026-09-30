import { describe, expect, it } from "vitest";

import { IntegrationProvider } from "../db";
import { getProvider } from "./index";

/**
 * The credential service calls `getProvider()` for every integration before it
 * decides whether a token needs refreshing, and `getProvider()` throws on a
 * name it does not know. So a provider added to the `IntegrationProvider` union
 * without a registry entry does not fail at compile time or at connect time —
 * it fails much later, inside a node, with an error about unknown OAuth
 * providers that says nothing about what the user was actually doing.
 *
 * Composio is the deliberate exception: it brokers OAuth on our behalf, so
 * there is no provider of ours to register and the credential service
 * short-circuits before reaching the registry. Every other provider must
 * resolve, and this test is what makes the next one impossible to forget.
 */

const BROKERED = new Set<string>(["composio"]);

describe("OAuth provider registry coverage", () => {
  const providers = Object.values(IntegrationProvider) as string[];

  it("covers every integration provider that owns its own OAuth", () => {
    const missing = providers
      .filter((p) => !BROKERED.has(p))
      .filter((p) => {
        try {
          return !getProvider(p);
        } catch {
          return true;
        }
      });

    expect(missing).toEqual([]);
  });

  it("has no registry entry for brokered providers", () => {
    // If this ever starts passing, Composio grew a real OAuth provider and the
    // short-circuit in the credential service should be revisited rather than
    // left as dead code.
    expect(() => getProvider("composio")).toThrow(/Unknown OAuth provider/);
  });

  it("keeps the brokered list to providers that actually exist", () => {
    for (const brokered of BROKERED) {
      expect(providers).toContain(brokered);
    }
  });
});

import type { Node } from "@dafthunk/types";
import { describe, expect, it } from "vitest";

import { extractComposioTrigger } from "./composio-trigger-sync";

/**
 * Saving a Composio-triggered workflow has to leave a `composio_triggers` row
 * behind: the reconciler works from that table, so without a row nothing ever
 * subscribes upstream and the workflow silently never fires. This is the step
 * that turns a saved graph into that row.
 */

const node = (inputs: Array<{ name: string; value?: unknown }>): Node =>
  ({
    id: "trigger",
    type: "receive-composio-event",
    name: "Github: Star Added Event",
    inputs: inputs.map((i) => ({ type: "string", ...i })),
    outputs: [],
  }) as unknown as Node;

describe("extractComposioTrigger", () => {
  it("reads the pinned slug and the chosen connection", () => {
    const result = extractComposioTrigger([
      node([
        { name: "triggerSlug", value: "GITHUB_STAR_ADDED_EVENT" },
        { name: "integrationId", value: "int_1" },
      ]),
    ]);

    expect(result).toEqual({
      triggerSlug: "GITHUB_STAR_ADDED_EVENT",
      integrationId: "int_1",
      config: {},
    });
  });

  it("collects the trigger's own config inputs", () => {
    // Everything that is not the slug or the connection is trigger config, and
    // it is what Composio needs to know which repo to watch.
    const result = extractComposioTrigger([
      node([
        { name: "triggerSlug", value: "GITHUB_STAR_ADDED_EVENT" },
        { name: "integrationId", value: "int_1" },
        { name: "owner", value: "acme" },
        { name: "repo", value: "widgets" },
      ]),
    ]);

    expect(result?.config).toEqual({ owner: "acme", repo: "widgets" });
  });

  it("omits config inputs the author never filled in", () => {
    // Sending undefined would make Composio validate a field nobody set.
    const result = extractComposioTrigger([
      node([
        { name: "triggerSlug", value: "GITHUB_STAR_ADDED_EVENT" },
        { name: "integrationId", value: "int_1" },
        { name: "owner", value: "acme" },
        { name: "repo" },
      ]),
    ]);

    expect(result?.config).toEqual({ owner: "acme" });
  });

  it("returns null when the graph has no Composio trigger node", () => {
    const other = {
      id: "n",
      type: "text",
      inputs: [],
      outputs: [],
    } as unknown as Node;
    expect(extractComposioTrigger([other])).toBeNull();
  });

  it("returns null when the slug pin is missing", () => {
    // Without a slug there is nothing to subscribe to; a row would only make
    // the reconciler fail on every pass.
    expect(
      extractComposioTrigger([
        node([{ name: "integrationId", value: "int_1" }]),
      ])
    ).toBeNull();
  });

  it("still records the row when no connection is chosen yet", () => {
    // A half-configured workflow is normal while editing. The row is written
    // with a null integration so the reconciler can skip it until it is set,
    // rather than the trigger being forgotten entirely.
    const result = extractComposioTrigger([
      node([{ name: "triggerSlug", value: "GITHUB_STAR_ADDED_EVENT" }]),
    ]);

    expect(result).toEqual({
      triggerSlug: "GITHUB_STAR_ADDED_EVENT",
      integrationId: null,
      config: {},
    });
  });

  it("ignores a second trigger node rather than guessing", () => {
    const result = extractComposioTrigger([
      node([
        { name: "triggerSlug", value: "GITHUB_STAR_ADDED_EVENT" },
        { name: "integrationId", value: "int_1" },
      ]),
      node([
        { name: "triggerSlug", value: "SLACK_NEW_MESSAGE" },
        { name: "integrationId", value: "int_2" },
      ]),
    ]);

    // One workflow, one subscription: the table is keyed by workflow id.
    expect(result?.triggerSlug).toBe("GITHUB_STAR_ADDED_EVENT");
  });
});

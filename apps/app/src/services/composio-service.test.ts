import { describe, expect, it } from "vitest";

import {
  buildComposioSearchQuery,
  COMPOSIO_META_KEY,
  COMPOSIO_TOOLS_ENDPOINT,
  COMPOSIO_TRIGGERS_ENDPOINT,
  describeComposioSearchError,
  emptyStateMessage,
  parseComposioMeta,
  SEARCH_PAGE_SIZE,
  shapeComposioResult,
  toolkitDisplayName,
  toolkitLogoUrl,
} from "./composio-service";

/** Minimal NodeType fixture — only the fields the pure helpers read. */
function nodeType(
  overrides: { metadata?: Record<string, string>; tags?: string[] } = {}
) {
  return {
    id: "composio:GITHUB_CREATE_AN_ISSUE",
    name: "GitHub: Create an issue",
    type: "composio-action",
    tags: overrides.tags ?? ["Composio", "GitHub"],
    icon: "plug",
    inputs: [],
    outputs: [],
    metadata: overrides.metadata,
  };
}

const TOOLKITS = [
  { slug: "github", name: "GitHub", logo: "https://example.com/github.png" },
  { slug: "gmail", name: "Gmail", logo: "https://example.com/gmail.png" },
];

describe("buildComposioSearchQuery", () => {
  it("builds a bare tools endpoint for an empty query", () => {
    expect(buildComposioSearchQuery({ mode: "tools" })).toBe(
      `${COMPOSIO_TOOLS_ENDPOINT}?limit=${SEARCH_PAGE_SIZE}`
    );
  });

  it("builds a bare triggers endpoint for an empty query", () => {
    expect(buildComposioSearchQuery({ mode: "triggers" })).toBe(
      `${COMPOSIO_TRIGGERS_ENDPOINT}?limit=${SEARCH_PAGE_SIZE}`
    );
  });

  it("encodes the query and drops surrounding whitespace", () => {
    const url = buildComposioSearchQuery({
      mode: "tools",
      query: "  create star   ",
    });
    expect(url).toContain("query=create+star");
  });

  it("adds toolkit for tools and omits it for triggers", () => {
    const tools = buildComposioSearchQuery({
      mode: "tools",
      query: "issue",
      toolkit: "github",
    });
    expect(tools).toContain("toolkit=github");

    const triggers = buildComposioSearchQuery({
      mode: "triggers",
      query: "issue",
      toolkit: "github",
    });
    expect(triggers).not.toContain("toolkit");
  });

  it("passes cursor and custom limit through", () => {
    const url = buildComposioSearchQuery({
      mode: "tools",
      query: "issue",
      limit: 20,
      cursor: "abc123",
    });
    expect(url).toContain("limit=20");
    expect(url).toContain("cursor=abc123");
  });
});

describe("parseComposioMeta", () => {
  it("decodes a valid metadata blob", () => {
    expect(
      parseComposioMeta(
        nodeType({
          metadata: {
            [COMPOSIO_META_KEY]: JSON.stringify({
              toolkitSlug: "github",
              toolkitName: "GitHub",
              description: "Creates an issue",
            }),
          },
        })
      )
    ).toEqual({
      toolkitSlug: "github",
      toolkitName: "GitHub",
      description: "Creates an issue",
    });
  });

  it("returns an empty object when metadata is missing", () => {
    expect(parseComposioMeta(nodeType())).toEqual({});
  });

  it("returns an empty object when the blob is malformed", () => {
    expect(
      parseComposioMeta(nodeType({ metadata: { [COMPOSIO_META_KEY]: "{" } }))
    ).toEqual({});
  });

  it("drops non-string fields instead of trusting the blob", () => {
    expect(
      parseComposioMeta(
        nodeType({
          metadata: {
            [COMPOSIO_META_KEY]: JSON.stringify({ toolkitSlug: 42 }),
          },
        })
      )
    ).toEqual({});
  });
});

describe("toolkitDisplayName", () => {
  it("prefers the metadata toolkit name", () => {
    expect(
      toolkitDisplayName(
        nodeType({
          metadata: {
            [COMPOSIO_META_KEY]: JSON.stringify({ toolkitName: "GitHub" }),
          },
        })
      )
    ).toBe("GitHub");
  });

  it("falls back to the second tag", () => {
    expect(toolkitDisplayName(nodeType({ tags: ["Composio", "Gmail"] }))).toBe(
      "Gmail"
    );
  });

  it("skips the 'Trigger' tag when metadata is absent", () => {
    expect(
      toolkitDisplayName(nodeType({ tags: ["Composio", "GitHub", "Trigger"] }))
    ).toBe("GitHub");
  });

  it("has a last-resort label", () => {
    expect(toolkitDisplayName(nodeType({ tags: ["Composio"] }))).toBe(
      "Composio"
    );
  });
});

describe("toolkitLogoUrl", () => {
  it("returns the logo for a known toolkit", () => {
    expect(toolkitLogoUrl(TOOLKITS, "github")).toBe(
      "https://example.com/github.png"
    );
  });

  it("returns undefined for an unknown slug", () => {
    expect(toolkitLogoUrl(TOOLKITS, "slack")).toBeUndefined();
  });

  it("returns undefined without a slug", () => {
    expect(toolkitLogoUrl(TOOLKITS, undefined)).toBeUndefined();
  });
});

describe("shapeComposioResult", () => {
  it("builds a row with toolkit name and logo", () => {
    const row = shapeComposioResult(
      nodeType({
        metadata: {
          [COMPOSIO_META_KEY]: JSON.stringify({ toolkitSlug: "github" }),
        },
      }),
      TOOLKITS
    );
    expect(row.toolkitSlug).toBe("github");
    expect(row.toolkitName).toBe("GitHub");
    expect(row.logoUrl).toBe("https://example.com/github.png");
    expect(row.nodeType).toBeDefined();
  });

  it("leaves logoUrl undefined when the catalog has no logo", () => {
    const row = shapeComposioResult(nodeType(), []);
    expect(row.logoUrl).toBeUndefined();
    expect(row.toolkitName).toBe("GitHub");
  });
});

describe("describeComposioSearchError", () => {
  it("advises an admin action for the unconfigured message", () => {
    const copy = describeComposioSearchError(
      new Error("Composio is not configured")
    );
    expect(copy).toContain("admin");
    expect(copy).toContain("API key");
  });

  it("advises a retry for upstream failures", () => {
    const copy = describeComposioSearchError(
      new Error("Failed to search Composio tools")
    );
    expect(copy).toContain("try again");
  });

  it("wraps unknown errors with the raw message", () => {
    expect(describeComposioSearchError(new Error("boom"))).toContain("boom");
  });
});

describe("emptyStateMessage", () => {
  it("quotes the query for tools", () => {
    expect(emptyStateMessage("tools", "star")).toBe('No tools match "star".');
  });

  it("scopes the message to a toolkit filter", () => {
    expect(emptyStateMessage("tools", "star", "GitHub")).toBe(
      'No tools match "star" in GitHub.'
    );
  });

  it("uses the trigger noun for triggers", () => {
    expect(emptyStateMessage("triggers", "star")).toBe(
      'No triggers match "star".'
    );
  });

  it("stays generic without a query", () => {
    expect(emptyStateMessage("tools", "   ")).toBe("No tools found.");
  });
});

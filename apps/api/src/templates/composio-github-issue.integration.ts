import {
  COMPOSIO_ACTION_NODE_TYPE,
  COMPOSIO_TOOL_SLUG_INPUT,
  COMPOSIO_TOOL_VERSION_INPUT,
  COMPOSIO_TRIGGER_NODE_TYPE,
  COMPOSIO_TRIGGER_SLUG_INPUT,
} from "@dafthunk/types";
import { describe, expect, it } from "vitest";

import { composioGithubIssueTemplate } from "./composio-github-issue";

const TRIGGER_SLUG = "GITHUB_STAR_ADDED_EVENT";
const ACTION_SLUG = "GITHUB_CREATE_AN_ISSUE";
const ACTION_VERSION = "20260728_00";

const nodeById = (id: string) =>
  composioGithubIssueTemplate.nodes.find((node) => node.id === id);

const inputNamed = (
  node: ReturnType<typeof nodeById> | undefined,
  name: string
) => node?.inputs.find((input) => input.name === name);

describe("Composio GitHub Issue Template", () => {
  it("should have valid structure", () => {
    expect(composioGithubIssueTemplate.nodes).toHaveLength(3);
    expect(composioGithubIssueTemplate.edges).toHaveLength(4);

    const nodeIds = new Set(
      composioGithubIssueTemplate.nodes.map((node) => node.id)
    );
    for (const edge of composioGithubIssueTemplate.edges) {
      expect(nodeIds.has(edge.source)).toBe(true);
      expect(nodeIds.has(edge.target)).toBe(true);
    }
  });

  it("should contain exactly the intended node types", () => {
    const nodeTypes = composioGithubIssueTemplate.nodes.map(
      (node) => node.type
    );
    expect(new Set(nodeTypes)).toEqual(
      new Set([
        COMPOSIO_TRIGGER_NODE_TYPE,
        "var-string-template",
        COMPOSIO_ACTION_NODE_TYPE,
      ])
    );
  });

  it("should have correct node ids and types", () => {
    expect(nodeById("trigger")?.type).toBe(COMPOSIO_TRIGGER_NODE_TYPE);
    expect(nodeById("format-title")?.type).toBe("var-string-template");
    expect(nodeById("create-issue")?.type).toBe(COMPOSIO_ACTION_NODE_TYPE);
  });

  it("should have correct edge connections", () => {
    const edges = composioGithubIssueTemplate.edges;

    expect(edges).toContainEqual({
      source: "trigger",
      target: "format-title",
      sourceOutput: "starred_by",
      targetInput: "var_1",
    });

    expect(edges).toContainEqual({
      source: "trigger",
      target: "format-title",
      sourceOutput: "repository_name",
      targetInput: "var_2",
    });

    expect(edges).toContainEqual({
      source: "format-title",
      target: "create-issue",
      sourceOutput: "result",
      targetInput: "title",
    });

    expect(edges).toContainEqual({
      source: "trigger",
      target: "create-issue",
      sourceOutput: "repository_name",
      targetInput: "repo",
    });
  });

  it("should be a composio_event triggered workflow", () => {
    expect(composioGithubIssueTemplate.trigger).toBe("composio_event");
  });

  it("should pin the trigger slug on the trigger node", () => {
    const triggerSlug = inputNamed(
      nodeById("trigger"),
      COMPOSIO_TRIGGER_SLUG_INPUT
    );

    expect(triggerSlug).toMatchObject({
      hidden: true,
      required: true,
      value: TRIGGER_SLUG,
    });
  });

  it("should pin the tool slug and version on the action node", () => {
    const toolSlug = inputNamed(
      nodeById("create-issue"),
      COMPOSIO_TOOL_SLUG_INPUT
    );
    expect(toolSlug).toMatchObject({
      hidden: true,
      required: true,
      value: ACTION_SLUG,
    });

    // The version pin is the load-bearing half: without it an upstream
    // Composio revision could change this template's schema later.
    const toolVersion = inputNamed(
      nodeById("create-issue"),
      COMPOSIO_TOOL_VERSION_INPUT
    );
    expect(toolVersion).toMatchObject({
      hidden: true,
      value: ACTION_VERSION,
    });
  });

  it("should scope both nodes' integration pickers to the github toolkit", () => {
    for (const id of ["trigger", "create-issue"]) {
      expect(inputNamed(nodeById(id), "integrationId")).toMatchObject({
        type: "integration",
        provider: "composio",
        toolkit: "github",
      });
    }
  });

  it("should satisfy every required action input by wire or value", () => {
    const action = nodeById("create-issue");
    expect(action).toBeDefined();
    if (!action) return;

    // Node-owned plumbing (connection, pins) is settled by the user or the
    // catalog, not by the template graph — only the tool's own parameters
    // must each be wired or given a value.
    const nodeOwnedInputs = new Set([
      "integrationId",
      COMPOSIO_TOOL_SLUG_INPUT,
      COMPOSIO_TOOL_VERSION_INPUT,
    ]);

    const wiredInputs = new Set(
      composioGithubIssueTemplate.edges
        .filter((edge) => edge.target === "create-issue")
        .map((edge) => edge.targetInput)
    );

    for (const input of action.inputs.filter(
      (parameter) => parameter.required && !nodeOwnedInputs.has(parameter.name)
    )) {
      expect(
        wiredInputs.has(input.name) || input.value !== undefined,
        `${input.name} must be wired by an edge or given a value`
      ).toBe(true);
    }
  });
});

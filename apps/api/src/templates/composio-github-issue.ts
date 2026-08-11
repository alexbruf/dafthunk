import {
  COMPOSIO_ACTION_NODE_TYPE,
  COMPOSIO_LOCKED_KEY,
  COMPOSIO_META_KEY,
  COMPOSIO_TOOL_SLUG_INPUT,
  COMPOSIO_TOOL_VERSION_INPUT,
  COMPOSIO_TRIGGER_NODE_TYPE,
  COMPOSIO_TRIGGER_SLUG_INPUT,
  type Node,
  type WorkflowTemplate,
} from "@dafthunk/types";

/**
 * Verified against the live Composio catalog:
 *  - `GITHUB_STAR_ADDED_EVENT` is the trigger type for "star added" (the bare
 *    `GITHUB_STAR_ADDED` does not exist upstream — GitHub triggers carry the
 *    `_EVENT` suffix, cf. `GITHUB_COMMIT_EVENT`).
 *  - `GITHUB_CREATE_AN_ISSUE` requires `owner`, `repo` and `title`.
 * Both are pinned as hidden inputs so an upstream tool revision can't silently
 * change this template's schema.
 */
const GITHUB_STAR_TRIGGER_SLUG = "GITHUB_STAR_ADDED_EVENT";
const GITHUB_CREATE_ISSUE_SLUG = "GITHUB_CREATE_AN_ISSUE";
const GITHUB_CREATE_ISSUE_VERSION = "20260728_00";

const GITHUB_ISSUE_DESCRIPTION =
  "Creates a new issue in a GitHub repository, requiring the repository to exist and have issues enabled; specific fields like assignees, milestone, or labels may require push access.";

/** Display metadata matching what the catalog synthesis stamps on each entry. */
const githubComposioMetadata = (
  description: string
): Record<string, string> => ({
  [COMPOSIO_META_KEY]: JSON.stringify({
    toolkitSlug: "github",
    toolkitName: "Github",
    description,
  }),
  [COMPOSIO_LOCKED_KEY]: "true",
});

/**
 * The star trigger (top-left): fires when a star is added, exposing the star
 * event's payload as typed outputs and the config inputs (`owner`, `repo`)
 * that tell Composio which repository to watch.
 */
const triggerNode: Node = {
  id: "trigger",
  name: "New GitHub Star",
  type: COMPOSIO_TRIGGER_NODE_TYPE,
  description: "Triggered when a new star is added to the repository.",
  icon: "plug-zap",
  position: { x: 100, y: 200 },
  inputs: [
    {
      name: "integrationId",
      type: "integration",
      provider: "composio",
      toolkit: "github",
      description: "Github connection to subscribe with",
      hidden: true,
      required: true,
    },
    {
      name: COMPOSIO_TRIGGER_SLUG_INPUT,
      type: "string",
      description: "Composio trigger this node subscribes to",
      hidden: true,
      required: true,
      value: GITHUB_STAR_TRIGGER_SLUG,
    },
    {
      name: "owner",
      type: "string",
      description: "Owner of the repository",
      required: true,
      value: "your-github-owner",
    },
    {
      name: "repo",
      type: "string",
      description: "Repository name",
      required: true,
      value: "your-repository",
    },
  ],
  outputs: [
    {
      name: "action",
      type: "string",
      description: "The action that was performed on the star",
    },
    {
      name: "repository_id",
      type: "number",
      description: "The unique ID assigned to the repository",
    },
    {
      name: "repository_name",
      type: "string",
      description: "The name of the repository",
    },
    {
      name: "repository_url",
      type: "string",
      description: "The GitHub URL of the repository",
    },
    {
      name: "starred_at",
      type: "string",
      description: "The timestamp when the star was added",
    },
    {
      name: "starred_by",
      type: "string",
      description: "The GitHub username of the user who added the star",
    },
    {
      name: "triggerSlug",
      type: "string",
      description: "Trigger that fired",
      hidden: true,
    },
    {
      name: "toolkitSlug",
      type: "string",
      description: "Toolkit the event came from",
      hidden: true,
    },
    {
      name: "eventId",
      type: "string",
      description: "Composio event id, unique per delivery",
      hidden: true,
    },
  ],
  metadata: githubComposioMetadata(
    "Triggered when a new star is added to the repository."
  ),
};

/**
 * A small formatting step (top-middle): turns the star payload into a readable
 * issue title. The star event's payload carries the repo *name* and the
 * starrer's username — both wired here — but no owner field, which is why
 * `owner` on the action below is a literal placeholder the user fills once.
 */
const formatTitleNode: Node = {
  id: "format-title",
  name: "Format Issue Title",
  type: "var-string-template",
  description:
    "Create a string using a template with variable injection using ${variableName} syntax",
  icon: "quote",
  position: { x: 500, y: 200 },
  inputs: [
    {
      name: "template",
      type: "string",
      description:
        "The template string with variables in ${variableName} format",
      required: true,
      value: "New GitHub star from ${var_1} on ${var_2}",
    },
    {
      name: "var_1",
      type: "string",
      description: "Variable value to inject",
    },
    {
      name: "var_2",
      type: "string",
      description: "Variable value to inject",
    },
  ],
  outputs: [
    {
      name: "result",
      type: "string",
      description: "The resulting string with variables replaced",
    },
    {
      name: "missingVariables",
      type: "json",
      description:
        "Array of variable names that were not found in the provided inputs",
      hidden: true,
    },
  ],
};

/**
 * The action (right): creates the issue on the starred repository. `repo`
 * comes from the star event's payload, `title` from the formatting step, and
 * `owner` is a placeholder the user aligns with the trigger's config.
 */
const createIssueNode: Node = {
  id: "create-issue",
  name: "Create GitHub Issue",
  type: COMPOSIO_ACTION_NODE_TYPE,
  description: GITHUB_ISSUE_DESCRIPTION,
  icon: "plug",
  position: { x: 900, y: 200 },
  inputs: [
    {
      name: "integrationId",
      type: "integration",
      provider: "composio",
      toolkit: "github",
      description: "Github connection to run this as",
      hidden: true,
      required: true,
    },
    {
      name: COMPOSIO_TOOL_SLUG_INPUT,
      type: "string",
      description: "Composio tool this node runs",
      hidden: true,
      required: true,
      value: GITHUB_CREATE_ISSUE_SLUG,
    },
    {
      name: COMPOSIO_TOOL_VERSION_INPUT,
      type: "string",
      description: "Composio tool version this node's schema was built from",
      hidden: true,
      required: false,
      value: GITHUB_CREATE_ISSUE_VERSION,
    },
    {
      name: "body",
      type: "string",
      description:
        "Issue body — The detailed textual contents of the new issue.",
      hidden: true,
      value:
        "This issue was created automatically by Dafthunk after a new GitHub star.",
    },
    {
      name: "repo",
      type: "string",
      description:
        "Repository name — The name of the repository, without the `.git` extension (case-insensitive). The repository must exist, be accessible, and have issues enabled.",
      required: true,
    },
    {
      name: "owner",
      type: "string",
      description:
        "Owner account — The GitHub account owner of the repository (case-insensitive). The repository must exist and be accessible to the authenticated user.",
      required: true,
      value: "your-github-owner",
    },
    {
      name: "title",
      type: "string",
      description: "Issue title — The title for the new issue.",
      required: true,
    },
    {
      name: "labels",
      type: "string",
      repeated: true,
      description:
        "Issue labels — Array of label names to associate with this issue (generally case-insensitive). NOTE: Only users with push access can set labels; they are silently dropped otherwise. Pass an empty list to clear all labels.",
      hidden: true,
    },
    {
      name: "assignee",
      type: "string",
      description:
        "Assignee — Login for the user to whom this issue should be assigned. NOTE: Only users with push access can set the assignee; it is silently dropped otherwise. **This field is deprecated in favor of `assignees`.**",
      hidden: true,
    },
    {
      name: "assignees",
      type: "string",
      repeated: true,
      description:
        "Assignees — GitHub login names for users to assign to this issue. NOTE: Only users with push access can set assignees; they are silently dropped otherwise.",
      hidden: true,
    },
    {
      name: "milestone",
      type: "string",
      description:
        'Milestone ID — The ID of the milestone to associate this issue with (e.g., "5"). NOTE: Only users with push access can set the milestone; it is silently dropped otherwise.',
      hidden: true,
    },
  ],
  outputs: [
    {
      name: "data",
      type: "json",
      description: "Data from the action execution",
    },
    {
      name: "error",
      type: "string",
      description: "Error if any occurred during the execution of the action",
      hidden: true,
    },
    {
      name: "successful",
      type: "boolean",
      description: "Whether or not the action execution was successful or not",
      hidden: true,
    },
    {
      name: "logId",
      type: "string",
      description: "Composio execution log id, for support and debugging",
      hidden: true,
    },
  ],
  metadata: githubComposioMetadata(GITHUB_ISSUE_DESCRIPTION),
};

export const composioGithubIssueTemplate: WorkflowTemplate = {
  id: "composio-github-issue",
  name: "GitHub Star to Issue",
  description: "Open a GitHub issue whenever someone stars your repository",
  icon: "star",
  trigger: "composio_event",
  tags: ["github", "composio", "automation"],
  nodes: [triggerNode, formatTitleNode, createIssueNode],
  edges: [
    {
      source: "trigger",
      target: "format-title",
      sourceOutput: "starred_by",
      targetInput: "var_1",
    },
    {
      source: "trigger",
      target: "format-title",
      sourceOutput: "repository_name",
      targetInput: "var_2",
    },
    {
      source: "format-title",
      target: "create-issue",
      sourceOutput: "result",
      targetInput: "title",
    },
    {
      source: "trigger",
      target: "create-issue",
      sourceOutput: "repository_name",
      targetInput: "repo",
    },
  ],
};

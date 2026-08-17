import { env } from "cloudflare:test";
import {
  type ComposioTool,
  type ComposioTriggerType,
  composioToolSchema,
  composioTriggerTypeSchema,
} from "@dafthunk/runtime/utils/composio-client";
import {
  COMPOSIO_ACTION_NODE_TYPE,
  COMPOSIO_LOCKED_KEY,
  COMPOSIO_META_KEY,
  COMPOSIO_TOOL_SLUG_INPUT,
  COMPOSIO_TOOL_VERSION_INPUT,
  COMPOSIO_TRIGGER_NODE_TYPE,
  COMPOSIO_TRIGGER_SLUG_INPUT,
  type NodeType,
  type Parameter,
} from "@dafthunk/types";
import { describe, expect, it } from "vitest";

import type { Bindings, DeferredWorkContext } from "../context";
import {
  buildComposioActionNodeType,
  buildComposioTriggerNodeType,
  getComposioNodeTypes,
} from "./composio-catalog";

/**
 * Fixtures at the bottom of this file are verbatim payloads: tool schemas come
 * from `https://docs.composio.dev/api/tools/<SLUG>` (public, unauthenticated)
 * and trigger types from `/api/v3.1/triggers_types`. Both are parsed through
 * the client's own zod schemas here, so a fixture that stops resembling a real
 * response fails loudly instead of quietly testing a shape that never ships.
 *
 * Nothing in this file touches the network.
 */

const asTool = (raw: unknown): ComposioTool => composioToolSchema.parse(raw);
const asTrigger = (raw: unknown): ComposioTriggerType =>
  composioTriggerTypeSchema.parse(raw);

/** Synthesise an action, failing the test if the tool was rejected. */
function action(raw: unknown): NodeType {
  const result = buildComposioActionNodeType(asTool(raw));
  if (!result.ok) {
    throw new Error(`expected a synthesised node type, got: ${result.reason}`);
  }
  return result.nodeType;
}

const trigger = (raw: unknown): NodeType =>
  buildComposioTriggerNodeType(asTrigger(raw));

const inputNamed = (node: NodeType, name: string): Parameter | undefined =>
  node.inputs.find((p) => p.name === name);

const outputNamed = (node: NodeType, name: string): Parameter | undefined =>
  node.outputs.find((p) => p.name === name);

describe("buildComposioActionNodeType", () => {
  it("gives every tool its own palette id while dispatching to one runtime node", () => {
    const node = action(GITHUB_CREATE_AN_ISSUE_RAW);

    expect(node.id).toBe("composio:GITHUB_CREATE_AN_ISSUE");
    expect(node.type).toBe(COMPOSIO_ACTION_NODE_TYPE);
    expect(node.type).toBe("composio-action");
  });

  it("pins both the tool slug and its version as hidden inputs with values", () => {
    const node = action(GITHUB_CREATE_AN_ISSUE_RAW);

    const slug = inputNamed(node, COMPOSIO_TOOL_SLUG_INPUT);
    expect(slug?.hidden).toBe(true);
    expect(slug?.required).toBe(true);
    expect(slug?.value).toBe("GITHUB_CREATE_AN_ISSUE");

    // The version pin is the load-bearing half: `execute` defaults to
    // "00000000_00" rather than latest, so an unpinned node's schema can drift
    // under workflows that are already saved.
    const version = inputNamed(node, COMPOSIO_TOOL_VERSION_INPUT);
    expect(version?.hidden).toBe(true);
    expect(version?.value).toBe("20260728_00");
  });

  it("scopes the integration picker to the tool's own toolkit", () => {
    const node = action(GITHUB_CREATE_AN_ISSUE_RAW);
    const integration = inputNamed(node, "integrationId");

    expect(integration?.type).toBe("integration");
    expect(integration).toMatchObject({
      type: "integration",
      provider: "composio",
      toolkit: "github",
    });
  });

  it("carries display metadata and the lock flag without leaking them as inputs", () => {
    const node = action(GITHUB_CREATE_AN_ISSUE_RAW);

    expect(node.metadata?.[COMPOSIO_LOCKED_KEY]).toBe("true");
    const meta = JSON.parse(node.metadata?.[COMPOSIO_META_KEY] ?? "{}");
    expect(meta).toMatchObject({
      toolkitSlug: "github",
      toolkitName: "Github",
    });
    expect(typeof meta.description).toBe("string");

    expect(node.inputs.some((p) => p.name === COMPOSIO_META_KEY)).toBe(false);
    expect(node.inputs.some((p) => p.name === COMPOSIO_LOCKED_KEY)).toBe(false);
  });

  it("maps array-of-string parameters to repeated string inputs", () => {
    const node = action(GITHUB_CREATE_AN_ISSUE_RAW);

    for (const name of ["labels", "assignees"]) {
      const param = inputNamed(node, name);
      expect(param?.type, name).toBe("string");
      expect(param?.repeated, name).toBe(true);
      // The raw schema's `default: []` must not survive onto a field typed
      // `string | number | boolean`.
      expect(param?.default, name).toBeUndefined();
    }

    // A scalar string of the same family stays a single input.
    const assignee = inputNamed(node, "assignee");
    expect(assignee?.type).toBe("string");
    expect(assignee?.repeated).toBeUndefined();
  });

  it("leaves arrays that are not arrays-of-string as json", () => {
    // `cc`/`bcc` are array<string> and become repeated strings...
    expect(inputNamed(action(GMAIL_SEND_EMAIL_RAW), "cc")).toMatchObject({
      type: "string",
      repeated: true,
    });

    // ...while Slack's `blocks` is an array of objects, which has no repeated
    // equivalent and must stay a single json input.
    const blocks = inputNamed(action(SLACK_SEND_MESSAGE_RAW), "blocks");
    expect(blocks?.type).toBe("json");
    expect(blocks?.repeated).toBeUndefined();
  });

  it("prefers Composio's human parameter name for display", () => {
    const node = action(GITHUB_CREATE_AN_ISSUE_RAW);

    const labels = inputNamed(node, "labels");
    expect(labels?.description?.startsWith("Issue labels")).toBe(true);
    // The technical description carries constraints the human name drops, so
    // it must still be there.
    expect(labels?.description).toContain("Only users with push access");

    // The wire name is the Composio argument key and must not be renamed.
    expect(labels?.name).toBe("labels");
    expect(inputNamed(node, "Issue labels")).toBeUndefined();
  });

  it("falls back to the raw description when no human name is published", () => {
    const node = trigger(GITHUB_STAR_ADDED_EVENT_RAW);
    const owner = inputNamed(node, "owner");

    expect(owner?.description).toBe("Owner of the repository");
  });

  it("rejects a tool whose required parameter is a file upload", () => {
    const result = buildComposioActionNodeType(
      asTool(GOOGLEDRIVE_UPLOAD_FILE_RAW)
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("file_to_upload");
    expect(result.reason.toLowerCase()).toContain("file");
  });

  it("keeps a tool whose file upload parameter is optional, minus that parameter", () => {
    // Dropping the whole tool here would cost the palette GMAIL_SEND_EMAIL and
    // three of Gmail's other headline tools, all of which are perfectly usable
    // without an attachment.
    const node = action(GMAIL_SEND_EMAIL_RAW);

    expect(inputNamed(node, "attachment")).toBeUndefined();
    expect(inputNamed(node, "subject")?.type).toBe("string");
    expect(inputNamed(node, "body")?.type).toBe("string");
  });

  it("maps tool outputs and hides the execution envelope", () => {
    const node = action(GITHUB_CREATE_AN_ISSUE_RAW);

    expect(outputNamed(node, "data")?.type).toBe("json");
    expect(outputNamed(node, "successful")?.hidden).toBe(true);
    expect(outputNamed(node, "error")?.hidden).toBe(true);
    expect(outputNamed(node, "logId")).toMatchObject({
      type: "string",
      hidden: true,
    });
  });

  it("disambiguates names that repeat across toolkits", () => {
    // "Create an issue" alone collides with Jira, Linear and half a dozen
    // other toolkits in a flat palette.
    expect(action(GITHUB_CREATE_AN_ISSUE_RAW).name).toBe(
      "Github: Create an issue"
    );
  });

  it("keeps a whole toolkit's palette contribution inside its byte budget", () => {
    const node = action(GITHUB_CREATE_AN_ISSUE_RAW);
    const perTool = JSON.stringify(node).length;

    // GitHub publishes 893 tools; the palette ships only the 66 Composio
    // flags `important`. This bound is what keeps that decision honest — if a
    // synthesised entry starts carrying raw JSON Schema again, this fails
    // before /types grows a megabyte.
    const IMPORTANT_GITHUB_TOOLS = 66;
    expect(perTool).toBeLessThan(8 * 1024);
    expect(perTool * IMPORTANT_GITHUB_TOOLS).toBeLessThan(1024 * 1024);
  });
});

describe("buildComposioTriggerNodeType", () => {
  it("gives every trigger type its own palette id while dispatching to one runtime node", () => {
    const node = trigger(GITHUB_STAR_ADDED_EVENT_RAW);

    expect(node.id).toBe("composio-trigger:GITHUB_STAR_ADDED_EVENT");
    expect(node.type).toBe(COMPOSIO_TRIGGER_NODE_TYPE);
    expect(node.type).toBe("receive-composio-event");
    expect(node.trigger).toBe(true);
  });

  it("pins the trigger slug as a hidden input with a value", () => {
    const node = trigger(GITHUB_STAR_ADDED_EVENT_RAW);
    const slug = inputNamed(node, COMPOSIO_TRIGGER_SLUG_INPUT);

    expect(slug?.hidden).toBe(true);
    expect(slug?.required).toBe(true);
    expect(slug?.value).toBe("GITHUB_STAR_ADDED_EVENT");
  });

  it("scopes the integration picker to the trigger's toolkit", () => {
    expect(
      inputNamed(trigger(GITHUB_STAR_ADDED_EVENT_RAW), "integrationId")
    ).toMatchObject({
      type: "integration",
      provider: "composio",
      toolkit: "github",
    });
  });

  it("maps the trigger config to inputs", () => {
    const node = trigger(GITHUB_STAR_ADDED_EVENT_RAW);

    expect(inputNamed(node, "owner")).toMatchObject({
      type: "string",
      required: true,
    });
    expect(inputNamed(node, "repo")).toMatchObject({
      type: "string",
      required: true,
    });
  });

  it("maps the trigger payload to outputs", () => {
    const node = trigger(GITHUB_STAR_ADDED_EVENT_RAW);

    expect(outputNamed(node, "action")?.type).toBe("string");
    expect(outputNamed(node, "repository_id")?.type).toBe("number");
    expect(outputNamed(node, "starred_by")?.type).toBe("string");
  });

  it("emits a raw json output for a trigger that publishes no payload schema", () => {
    // 2 of 362 trigger types ship `payload.properties: {}`; a node with no
    // outputs cannot be wired to anything at all.
    const node = trigger(GOOGLEDRIVE_CHANGES_RAW);

    expect(node.id).toBe("composio-trigger:GOOGLEDRIVE_GOOGLE_DRIVE_CHANGES");
    expect(outputNamed(node, "payload")?.type).toBe("json");
    expect(node.outputs.length).toBeGreaterThan(0);

    // Its config still maps normally — only the payload was empty.
    expect(inputNamed(node, "interval")?.type).toBe("number");
  });

  it("keeps the whole trigger catalog inside its byte budget", () => {
    const perTrigger = JSON.stringify(
      trigger(GITHUB_STAR_ADDED_EVENT_RAW)
    ).length;

    // The full catalog is synthesised (unlike actions) because triggers are
    // discoverable before anything is connected. 362 types is the whole set.
    const TRIGGER_TYPES = 362;
    expect(perTrigger).toBeLessThan(8 * 1024);
    expect(perTrigger * TRIGGER_TYPES).toBeLessThan(2 * 1024 * 1024);
  });
});

describe("getComposioNodeTypes", () => {
  const noopContext: DeferredWorkContext = { waitUntil: () => undefined };

  it("synthesises nothing and throws nothing without a COMPOSIO_API_KEY", async () => {
    // `/types` must keep working exactly as it did before Composio existed in
    // every environment that has no key configured. The key is spread away
    // rather than read from the ambient test env so that a developer with a
    // real key in `.dev.vars` runs the same assertion CI does — and so this
    // test can never reach the network.
    const bindings = { ...env, COMPOSIO_API_KEY: undefined } as Bindings;

    await expect(
      getComposioNodeTypes(bindings, noopContext, "org-1")
    ).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Fixtures — verbatim upstream payloads, committed so the tests never call out.
// Tool schemas: https://docs.composio.dev/api/tools/<SLUG> (public endpoint).
// Trigger types: GET /api/v3.1/triggers_types.
// Two reductions were made, neither of which any assertion depends on: output
// `$defs` blocks (tens of KB of nested definitions the mapper never reads) are
// dropped, and SLACK_SEND_MESSAGE keeps three of its input properties.
// ---------------------------------------------------------------------------

const GITHUB_CREATE_AN_ISSUE_RAW = {
  slug: "GITHUB_CREATE_AN_ISSUE",
  name: "Create an issue",
  description:
    "Creates a new issue in a GitHub repository, requiring the repository to exist and have issues enabled; specific fields like assignees, milestone, or labels may require push access.",
  toolkit: {
    slug: "github",
    name: "github",
    logo: "https://logos.composio.dev/api/github",
  },
  version: "20260728_00",
  available_versions: ["20260728_00"],
  tags: ["important", "openWorldHint", "Repository Management", "createHint"],
  no_auth: false,
  is_deprecated: false,
  input_parameters: {
    type: "object",
    title: "CreateAnIssueRequest",
    required: ["owner", "repo", "title"],
    properties: {
      body: {
        type: "string",
        title: "Body",
        examples: [
          "Detailed description of the bug with steps to reproduce.",
          "I think adding a dark mode would improve user experience...",
        ],
        description: "The detailed textual contents of the new issue.",
        human_parameter_name: "Issue body",
        human_parameter_description:
          "Describe what is happening, what you expected, and any steps to reproduce or context. Add links, screenshots, or code snippets if helpful.",
      },
      repo: {
        type: "string",
        title: "Repo",
        examples: ["Spoon-Knife", "linux"],
        description:
          "The name of the repository, without the `.git` extension (case-insensitive). The repository must exist, be accessible, and have issues enabled.",
        human_parameter_name: "Repository name",
        human_parameter_description:
          "Enter the exact repository name (without .git) where you want to create the issue. The repository must have issues enabled in its settings.",
      },
      owner: {
        type: "string",
        title: "Owner",
        examples: ["octocat", "torvalds"],
        description:
          "The GitHub account owner of the repository (case-insensitive). The repository must exist and be accessible to the authenticated user.",
        human_parameter_name: "Owner account",
        human_parameter_description:
          "Enter the GitHub username or organization that owns the repository. This tells us where to create the issue.",
      },
      title: {
        type: "string",
        title: "Title",
        examples: ["Found a critical bug", "Feature request: Add dark mode"],
        description: "The title for the new issue.",
        human_parameter_name: "Issue title",
        human_parameter_description:
          "A short, clear headline for the issue so others can quickly understand the problem or request.",
      },
      labels: {
        type: "array",
        items: {
          type: "string",
        },
        title: "Labels",
        examples: [
          ["bug", "critical"],
          ["enhancement", "ui"],
          ["documentation"],
        ],
        description:
          "Array of label names to associate with this issue (generally case-insensitive). NOTE: Only users with push access can set labels; they are silently dropped otherwise. Pass an empty list to clear all labels.",
        human_parameter_name: "Issue labels",
        human_parameter_description:
          "One or more labels to categorize the issue (e.g., bug, enhancement). You can enter a comma-separated list.",
      },
      assignee: {
        type: "string",
        title: "Assignee",
        examples: ["octocat", "monalisa"],
        description:
          "Login for the user to whom this issue should be assigned. NOTE: Only users with push access can set the assignee; it is silently dropped otherwise. **This field is deprecated in favor of `assignees`.**",
        human_parameter_name: "Assignee",
        human_parameter_description:
          "The GitHub username of the one person who should be assigned to this issue. Leave empty if you don't want to assign anyone yet.",
      },
      assignees: {
        type: "array",
        items: {
          type: "string",
        },
        title: "Assignees",
        examples: [["octocat"], ["monalisa", "hubot"]],
        description:
          "GitHub login names for users to assign to this issue. NOTE: Only users with push access can set assignees; they are silently dropped otherwise.",
        human_parameter_name: "Assignees",
        human_parameter_description:
          "GitHub usernames of everyone who should be assigned to this issue. You can enter a comma-separated list.",
      },
      milestone: {
        type: "string",
        title: "Milestone",
        examples: ["1", "5"],
        description:
          'The ID of the milestone to associate this issue with (e.g., "5"). NOTE: Only users with push access can set the milestone; it is silently dropped otherwise.',
        human_parameter_name: "Milestone ID",
        human_parameter_description:
          "The milestone number to associate with this issue for grouping and tracking. Use the numeric ID shown in the repository's Milestones list.",
      },
    },
    description:
      "Request schema for creating a new issue in a GitHub repository.",
  },
  output_parameters: {
    type: "object",
    title: "CreateAnIssueResponseWrapper",
    required: ["data", "successful"],
    properties: {
      data: {
        $ref: "#/$defs/CreateAnIssueResponse",
        title: "Data",
        description: "Data from the action execution",
      },
      error: {
        type: "string",
        title: "Error",
        description: "Error if any occurred during the execution of the action",
      },
      successful: {
        type: "boolean",
        title: "Successful",
        description:
          "Whether or not the action execution was successful or not",
      },
    },
  },
};

const GMAIL_SEND_EMAIL_RAW = {
  slug: "GMAIL_SEND_EMAIL",
  name: "Send Email",
  description:
    "Sends an email via Gmail API using the authenticated user's Google profile display name. Sends immediately and is irreversible — confirm recipients, subject, body, and attachments before calling. At least one of 'to' (or 'recipient_email'), 'cc', or 'bcc' must be provided. At least one of subject or body must be provided. Requires `is_html=True` if the body contains HTML. All common file types including PNG, JPG, PDF, MP4, etc. are supported as attachments. Gmail API limits total message size to ~25 MB after base64 encoding. To reply in an existing thread, use GMAIL_REPLY_TO_THREAD instead. No scheduled send support; enforce timing externally.",
  toolkit: {
    slug: "gmail",
    name: "gmail",
    logo: "https://logos.composio.dev/api/gmail",
  },
  version: "20260721_00",
  available_versions: ["20260721_00"],
  tags: ["important", "openWorldHint", "createHint"],
  no_auth: false,
  is_deprecated: false,
  input_parameters: {
    type: "object",
    title: "SendEmailRequest",
    properties: {
      cc: {
        type: "array",
        items: {
          type: "string",
        },
        title: "Cc",
        default: [],
        examples: [["manager@example.com", "teamlead@example.com"]],
        description:
          "Carbon Copy (CC) recipients' email addresses. At least one of 'to'/'recipient_email', 'cc', or 'bcc' must be provided.",
        human_parameter_name: "CC recipients' email addresses",
        human_parameter_description:
          "Provide email addresses of people you want to inform about the email without them being the main recipient.",
      },
      bcc: {
        type: "array",
        items: {
          type: "string",
        },
        title: "Bcc",
        default: [],
        examples: [["auditor@example.com"]],
        description:
          "Blind Carbon Copy (BCC) recipients' email addresses. At least one of 'to'/'recipient_email', 'cc', or 'bcc' must be provided.",
        human_parameter_name: "BCC recipients' email addresses",
        human_parameter_description:
          "Enter email addresses of people you want to receive the email without the main recipients knowing.",
      },
      body: {
        type: "string",
        title: "Body",
        examples: [
          "Hello team, let's discuss the project updates tomorrow.",
          "<h1>Welcome!</h1><p>Thank you for signing up.</p>",
          "",
        ],
        description:
          "Email content (plain text or HTML). Either subject or body must be provided for the email to be sent. If HTML, `is_html` must be `True`.",
        human_parameter_name: "Email content",
        human_parameter_description:
          "Write the main message of your email here. It can be plain text or formatted HTML.",
      },
      is_html: {
        type: "boolean",
        title: "Is Html",
        default: false,
        description: "Set to `True` if the email body contains HTML tags.",
        human_parameter_name: "Does the email body contain HTML?",
        human_parameter_description:
          "Indicate whether the content of your email is formatted with HTML.",
      },
      subject: {
        type: "string",
        title: "Subject",
        examples: ["Project Update Meeting", "Your Weekly Newsletter"],
        description:
          "Subject line of the email. Either subject or body must be provided for the email to be sent.",
        human_parameter_name: "Email subject line",
        human_parameter_description:
          "This is the title of your email that summarizes its content.",
      },
      user_id: {
        type: "string",
        title: "User Id",
        default: "me",
        examples: ["user@example.com", "me"],
        description:
          "User's email address; the literal 'me' refers to the authenticated user.",
        human_parameter_name: "User ID",
        human_parameter_description:
          "This is the email address of the user whose mailbox you want to access. You can use 'me' to refer to your own mailbox.",
      },
      attachment: {
        anyOf: [
          {
            type: "object",
            title: "FileUploadable",
            required: ["name", "mimetype", "s3key"],
            properties: {
              name: {
                type: "string",
                title: "Name",
                examples: ["document.pdf", "image.jpg", "report.docx"],
                description:
                  "The filename that will be used when uploading the file to the destination service",
              },
              s3key: {
                type: "string",
                title: "S3Key",
                examples: ["47563/gmail/GET_ATTACHMENT/response/12345"],
                description:
                  "The S3 key of a publicly accessible file, typically returned from a previous download action that stored the file in S3. This key references an existing file that can be uploaded to another service.",
              },
              mimetype: {
                type: "string",
                title: "Mimetype",
                examples: [
                  "application/pdf",
                  "image/jpeg",
                  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                ],
                description: "The MIME type of the file",
              },
            },
            file_uploadable: true,
          },
          {
            type: "array",
            items: {
              type: "object",
              title: "FileUploadable",
              required: ["name", "mimetype", "s3key"],
              properties: {
                name: {
                  type: "string",
                  title: "Name",
                  examples: ["document.pdf", "image.jpg", "report.docx"],
                  description:
                    "The filename that will be used when uploading the file to the destination service",
                },
                s3key: {
                  type: "string",
                  title: "S3Key",
                  examples: ["47563/gmail/GET_ATTACHMENT/response/12345"],
                  description:
                    "The S3 key of a publicly accessible file, typically returned from a previous download action that stored the file in S3. This key references an existing file that can be uploaded to another service.",
                },
                mimetype: {
                  type: "string",
                  title: "Mimetype",
                  examples: [
                    "application/pdf",
                    "image/jpeg",
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                  ],
                  description: "The MIME type of the file",
                },
              },
              file_uploadable: true,
            },
          },
        ],
        title: "Attachment",
        description:
          "File(s) to attach. Accepts a single file or a list of files. IMPORTANT: mimetype MUST contain a '/' separator - single words like 'pdf' or 'new' are invalid. Gmail API limits: total message size must not exceed ~25 MB after base64 encoding. Omit or set to null for no attachment. Empty attachment objects (with all fields empty/whitespace) are treated as no attachment.",
        human_parameter_name: "File(s) to attach",
        human_parameter_description:
          "If you want to send file(s) with your email, provide them here. Can be a single file or a list of files. The mimetype must be in 'type/subtype' format (e.g., 'application/pdf' for PDFs, 'image/png' for PNG files). Total size of all attachments should be under 20 MB before encoding.",
      },
      from_email: {
        type: "string",
        title: "From Email",
        examples: ["alias@example.com", "marketing@company.com"],
        description:
          "Sender email address for the 'From' header. Use this to send from a verified alias configured in Gmail's 'Send mail as' settings. When not provided, the authenticated user's primary email address is used. The alias must be verified in Gmail settings before use.",
        human_parameter_name: "Sender email address (alias)",
        human_parameter_description:
          "Specify a 'Send mail as' alias email address to send from. Must be pre-configured and verified in Gmail settings. Leave empty to use your primary email.",
      },
      recipient_email: {
        type: "string",
        title: "Recipient Email",
        examples: ["john@doe.com", "me"],
        description:
          "Primary recipient's email address. You can also use 'to' as an alias for this parameter. At least one of 'to'/'recipient_email', 'cc', or 'bcc' must be provided. Use extra_recipients if you want to send to multiple recipients. Use the special value 'me' to send to your own authenticated email address. Must be a full user@domain address; 'me' is not valid here and will fail.",
        human_parameter_name: "Primary recipient's email address",
        human_parameter_description:
          "Enter the main email address of the person you want to send the email to. Use 'me' to send to yourself.",
      },
      extra_recipients: {
        type: "array",
        items: {
          type: "string",
        },
        title: "Extra Recipients",
        default: [],
        examples: [["jane.doe@example.com", "support@example.com"]],
        description:
          "Additional 'To' recipients' email addresses (not Cc or Bcc). Should only be used if recipient_email is also provided.",
        human_parameter_name: "Additional 'To' recipients' email addresses",
        human_parameter_description:
          "List extra email addresses for other recipients you want to send the email to.",
      },
    },
  },
  output_parameters: {
    type: "object",
    title: "GmailMessageResponseWrapper",
    required: ["data", "successful"],
    properties: {
      data: {
        $ref: "#/$defs/GmailMessageResponse",
        title: "Data",
        description: "Data from the action execution",
      },
      error: {
        type: "string",
        title: "Error",
        description: "Error if any occurred during the execution of the action",
      },
      successful: {
        type: "boolean",
        title: "Successful",
        description:
          "Whether or not the action execution was successful or not",
      },
    },
  },
};

const GOOGLEDRIVE_UPLOAD_FILE_RAW = {
  slug: "GOOGLEDRIVE_UPLOAD_FILE",
  name: "Upload file",
  description:
    "Uploads a file to google drive, optionally to a specified folder.",
  toolkit: {
    slug: "googledrive",
    name: "googledrive",
    logo: "https://logos.composio.dev/api/googledrive",
  },
  version: "20260728_00",
  available_versions: ["20260728_00"],
  tags: [],
  no_auth: false,
  is_deprecated: false,
  input_parameters: {
    type: "object",
    title: "UploadFileRequest",
    required: ["file_to_upload"],
    properties: {
      file_to_upload: {
        type: "object",
        title: "FileUploadable",
        required: ["name", "mimetype", "s3key"],
        properties: {
          name: {
            type: "string",
            title: "Name",
            examples: ["document.pdf", "image.jpg", "report.docx"],
            description:
              "The filename that will be used when uploading the file to the destination service",
          },
          s3key: {
            type: "string",
            title: "S3Key",
            examples: ["47563/gmail/GET_ATTACHMENT/response/12345"],
            description:
              "The S3 key of a publicly accessible file, typically returned from a previous download action that stored the file in S3. This key references an existing file that can be uploaded to another service.",
          },
          mimetype: {
            type: "string",
            title: "Mimetype",
            examples: [
              "application/pdf",
              "image/jpeg",
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ],
            description: "The MIME type of the file",
          },
        },
        description:
          "File to upload to Google Drive (max 5MB). Use a clear filename and accurate MIME type, for example `application/pdf`; incorrect values can cause Drive to convert or misrender the file.",
        file_uploadable: true,
        additionalProperties: false,
        human_parameter_name: "File to upload",
        human_parameter_description: "The file to upload to Google Drive.",
      },
      folder_to_upload_to: {
        type: "string",
        title: "Folder To Upload To",
        examples: ["1duXYCvYC5tIp5B_B1HWLq8LyDYXfMhPU"],
        description:
          "Optional ID of the target Google Drive folder; can be obtained using 'Find Folder' or similar actions. Invalid or missing IDs silently fall back to Drive root with no error — resolve the correct folder ID first using GOOGLEDRIVE_FIND_FILE.",
        human_parameter_name: "Target folder ID",
        human_parameter_description:
          "If you want the file placed in a specific Drive folder, paste that folder's ID here. Leave it blank to upload to your My Drive (root) instead.",
      },
    },
  },
  output_parameters: {
    type: "object",
    title: "UploadFileResponseWrapper",
    required: ["data", "successful"],
    properties: {
      data: {
        $ref: "#/$defs/UploadFileResponse",
        title: "Data",
        description: "Data from the action execution",
      },
      error: {
        type: "string",
        title: "Error",
        description: "Error if any occurred during the execution of the action",
      },
      successful: {
        type: "boolean",
        title: "Successful",
        description:
          "Whether or not the action execution was successful or not",
      },
    },
  },
};

const GITHUB_STAR_ADDED_EVENT_RAW = {
  slug: "GITHUB_STAR_ADDED_EVENT",
  name: "Star Added Event",
  description: "Triggered when a new star is added to the repository.",
  type: "webhook",
  instructions:
    "This trigger fires every time a new star is added to the repository.",
  toolkit: {
    slug: "github",
    name: "github",
    logo: "https://logos.composio.dev/api/github",
  },
  config: {
    properties: {
      owner: {
        description: "Owner of the repository",
        title: "Owner",
        type: "string",
      },
      repo: {
        description: "Repository name",
        title: "Repo",
        type: "string",
      },
    },
    required: ["owner", "repo"],
    title: "WebhookConfigSchema",
    type: "object",
  },
  payload: {
    properties: {
      action: {
        description: "The action that was performed on the star",
        examples: ["created"],
        title: "Action",
        type: "string",
      },
      repository_id: {
        description: "The unique ID assigned to the repository",
        examples: [101],
        title: "Repository Id",
        type: "integer",
      },
      repository_name: {
        description: "The name of the repository",
        examples: ["Hello-World"],
        title: "Repository Name",
        type: "string",
      },
      repository_url: {
        description: "The GitHub URL of the repository",
        examples: ["https://github.com/octocat/Hello-World"],
        title: "Repository Url",
        type: "string",
      },
      starred_at: {
        description: "The timestamp when the star was added",
        examples: ["2021-04-14T02:15:15Z"],
        title: "Starred At",
        type: "string",
      },
      starred_by: {
        description: "The GitHub username of the user who added the star",
        examples: ["octocat"],
        title: "Starred By",
        type: "string",
      },
    },
    required: [
      "action",
      "starred_at",
      "repository_id",
      "repository_name",
      "repository_url",
      "starred_by",
    ],
    title: "StarAddedPayloadSchema",
    type: "object",
  },
  version: "20260728_00",
  requires_webhook_endpoint_setup: false,
};

const GOOGLEDRIVE_CHANGES_RAW = {
  slug: "GOOGLEDRIVE_GOOGLE_DRIVE_CHANGES",
  name: "Google Drive Changes",
  description: "Triggers when changes are detected in a Google Drive.",
  type: "poll",
  instructions:
    "\n    **Instructions for Setting Up the Trigger:**\n    - Ensure you have set the necessary permissions to access Google Drive.\n    - On first run the trigger baselines to the current change cursor and emits\n      no events; subsequent polls return any changes that occurred since the\n      previous poll.\n    - If Drive rejects a stored page token, the trigger raises an error instead\n      of silently re-baselining and dropping events in the gap.\n    ",
  toolkit: {
    slug: "googledrive",
    name: "googledrive",
    logo: "https://logos.composio.dev/api/googledrive",
  },
  config: {
    description: "Configuration for the Google Drive `Changes` trigger.",
    properties: {
      drive_id: {
        description:
          "Optional shared drive ID to monitor. When unset, the trigger monitors the user's My Drive plus any shared drives surfaced by `include_items_from_all_drives`.",
        title: "Drive Id",
        type: "string",
      },
      include_items_from_all_drives: {
        default: true,
        description:
          "Whether items from My Drive AND all visible shared drives should appear in results. Required for shared-drive coverage.",
        title: "Include Items From All Drives",
        type: "boolean",
      },
      interval: {
        default: 2,
        description:
          "Periodic Interval to Check for Updates & Send a Trigger in Minutes",
        title: "Interval",
        type: "number",
      },
      restrict_to_my_drive: {
        description:
          "If true, restrict results to changes inside the My Drive hierarchy even when `include_items_from_all_drives` is true.",
        title: "Restrict To My Drive",
        type: "boolean",
      },
      spaces: {
        default: "drive",
        description:
          "Comma-separated list of spaces to query. Supported values are 'drive' and 'appDataFolder'.",
        title: "Spaces",
        type: "string",
      },
    },
    title: "DriveConfig",
    type: "object",
  },
  payload: {
    additionalProperties: true,
    description:
      "A single Google Drive change resource as returned by `changes.list`.",
    properties: {},
    title: "DrivePayload",
    type: "object",
  },
  version: "20260811_00",
  requires_webhook_endpoint_setup: false,
};

const SLACK_SEND_MESSAGE_RAW = {
  slug: "SLACK_SEND_MESSAGE",
  name: "Send message",
  description:
    "Posts a message to a Slack channel, direct message, or private group.",
  toolkit: {
    slug: "slack",
    name: "slack",
    logo: "https://logos.composio.dev/api/slack",
  },
  version: "20260728_00",
  available_versions: ["20260728_00"],
  tags: [],
  no_auth: false,
  is_deprecated: false,
  input_parameters: {
    type: "object",
    title: "SendMessageRequest",
    required: ["channel"],
    properties: {
      channel: {
        type: "string",
        title: "Channel",
        examples: ["C1234567890", "general"],
        description:
          "ID or name of the channel, private group, or IM channel to send the message to. Can be specified as either 'channel' or 'channel_id'. Do NOT include the '#' prefix (e.g., use 'general' not '#general') - any leading '#' will be automatically stripped. For DMs, use the channel ID returned by SLACK_OPEN_DM (starts with 'D'); usernames, emails, and user IDs are not valid DM targets. IMPORTANT: org-wide (Enterprise Grid) tokens cannot resolve channel names — Slack returns `team_not_found`. Pass the channel ID (e.g., 'C0ABC12345') instead; use SLACK_LIST_ALL_CHANNELS to find IDs.",
        human_parameter_name: "Channel",
        human_parameter_description:
          "Where to send the message—enter a channel name (like general) or a channel ID (like C1234567890). You can also use a DM or private group. Do not include the '#' prefix; it will be automatically removed if provided.",
      },
      blocks: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: true,
        },
        title: "Blocks",
        examples: [
          [
            {
              text: "# Deploy approval\n\nApprove or reject production.",
              type: "markdown",
            },
            {
              type: "actions",
              elements: [
                {
                  text: {
                    text: "Approve",
                    type: "plain_text",
                  },
                  type: "button",
                  value: "approve_prod",
                  action_id: "approve_prod",
                },
              ],
            },
          ],
        ],
        description:
          "Use this instead of `markdown_text` only when you need Slack Block Kit capabilities that Markdown cannot express: buttons, approval/reject actions, select menus, checkboxes, radio buttons, date/time pickers, overflow menus, interactive workflow payloads, section accessories, image/video blocks, context rows, two-column fields, multiple action buttons in one row, or rich card-like layouts. Provide raw Slack Block Kit JSON as an array. For normal prose generated by an LLM inside a blocks payload, prefer a Slack markdown block: {'type': 'markdown', 'text': '# Heading\\n\\nBody text'}. Do not use this together with `markdown_text`. If these blocks are the visible content, provide `fallback_text` when notification/accessibility fallback matters.",
        human_parameter_name: "Slack Block Kit Blocks",
        human_parameter_description:
          "Raw Slack Block Kit blocks for interactive or structured layouts. Use Markdown Text for ordinary messages.",
      },
    },
  },
  output_parameters: {
    type: "object",
    title: "SendMessageResponseWrapper",
    required: ["data", "successful"],
    properties: {
      data: {
        $ref: "#/$defs/SendMessageResponse",
        title: "Data",
        description: "Data from the action execution",
      },
      error: {
        type: "string",
        title: "Error",
        description: "Error if any occurred during the execution of the action",
      },
      successful: {
        type: "boolean",
        title: "Successful",
        description:
          "Whether or not the action execution was successful or not",
      },
    },
  },
};

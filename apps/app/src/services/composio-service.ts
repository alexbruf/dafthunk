import { COMPOSIO_META_KEY, type NodeType } from "@dafthunk/types";

export { COMPOSIO_META_KEY };

/**
 * Pure helpers for the Composio tool/trigger search dialog.
 *
 * Everything here is deliberately free of React so it can be unit-tested the
 * moment a runner exists (and apps/app already has vitest). The dialog shapes
 * user intent into a query string, and a search result back into a row —
 * both transformations belong beside the API contract, not inside JSX.
 */

export const COMPOSIO_TOOLS_ENDPOINT = "/composio/tools";
export const COMPOSIO_TRIGGERS_ENDPOINT = "/composio/triggers";
export const COMPOSIO_TOOLKITS_ENDPOINT = "/composio/connect/toolkits";

/**
 * Page size for search. The route caps `limit` at 100 and a bigger page makes
 * the per-keystroke search slower; 50 keeps one screenful useful without
 * drowning the debounced round-trips.
 */
export const SEARCH_PAGE_SIZE = 50;

/** The two result modes the dialog toggles between. */
export type ComposioResultMode = "tools" | "triggers";

/** One page of search results, as returned by both search endpoints. */
export interface ComposioSearchPage {
  nodeTypes: NodeType[];
  nextCursor: string | null;
}

/** The subset of a toolkit record the dialog needs for logos and labels. */
export interface ComposioToolkitOption {
  slug: string;
  name: string;
  logo: string;
}

/** Decoded `_composio_meta` metadata; every field optional and validated. */
export interface ComposioMetaDisplay {
  toolkitSlug?: string;
  toolkitName?: string;
  description?: string;
}

/** The row view-model the dialog renders for one search result. */
export interface ComposioSearchRow {
  nodeType: NodeType;
  toolkitSlug?: string;
  toolkitName: string;
  logoUrl?: string;
}

/**
 * Build the search URL for one mode from structured inputs.
 *
 * The toolkit filter only applies to tools: the triggers route accepts the
 * param for schema symmetry but ignores it, and sending it would just
 * invalidate the SWR cache per keystroke for no behaviour.
 */
export function buildComposioSearchQuery(options: {
  mode: ComposioResultMode;
  query?: string;
  toolkit?: string;
  limit?: number;
  cursor?: string;
}): string {
  const endpoint =
    options.mode === "tools"
      ? COMPOSIO_TOOLS_ENDPOINT
      : COMPOSIO_TRIGGERS_ENDPOINT;

  const params = new URLSearchParams();
  const query = options.query?.trim();
  if (query) params.set("query", query);
  if (options.mode === "tools" && options.toolkit) {
    params.set("toolkit", options.toolkit);
  }
  params.set("limit", String(options.limit ?? SEARCH_PAGE_SIZE));
  if (options.cursor) params.set("cursor", options.cursor);

  const queryString = params.toString();
  return queryString ? `${endpoint}?${queryString}` : endpoint;
}

/**
 * Best-effort parse of a synthesised node's `_composio_meta` value. Returns an
 * empty object when the value is missing or malformed so callers can safely
 * spread the result — one bad metadata blob must not blank the whole row.
 */
export function parseComposioMeta(
  nodeType: Pick<NodeType, "metadata">
): ComposioMetaDisplay {
  const raw = nodeType.metadata?.[COMPOSIO_META_KEY];
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as ComposioMetaDisplay;
    return {
      toolkitSlug:
        typeof parsed.toolkitSlug === "string" ? parsed.toolkitSlug : undefined,
      toolkitName:
        typeof parsed.toolkitName === "string" ? parsed.toolkitName : undefined,
      description:
        typeof parsed.description === "string" ? parsed.description : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Reader-facing toolkit label for a result row. The synthesised node carries
 * it in metadata, with the toolkit label as the second tag back when metadata
 * is missing (an older node or a manual palette entry).
 */
export function toolkitDisplayName(
  nodeType: Pick<NodeType, "metadata" | "tags">
): string {
  const meta = parseComposioMeta(nodeType);
  if (meta.toolkitName) return meta.toolkitName;
  const tag = nodeType.tags[1];
  if (tag && tag !== "Trigger") return tag;
  return "Composio";
}

/**
 * Toolkit logo URL when the connect catalog knows the toolkit. Search covers
 * ~45,000 tools across 1,069 toolkits while `/composio/connect/toolkits` only
 * lists the ones Composio can broker auth for, so most results have no logo —
 * callers fall back to an initial-letter tile.
 */
export function toolkitLogoUrl(
  toolkits: readonly ComposioToolkitOption[],
  slug: string | undefined
): string | undefined {
  if (!slug) return undefined;
  return toolkits.find((toolkit) => toolkit.slug === slug)?.logo ?? undefined;
}

/** Shape one synthesised NodeType into a row the dialog can render. */
export function shapeComposioResult(
  nodeType: NodeType,
  toolkits: readonly ComposioToolkitOption[]
): ComposioSearchRow {
  const meta = parseComposioMeta(nodeType);
  return {
    nodeType,
    toolkitSlug: meta.toolkitSlug,
    toolkitName: toolkitDisplayName(nodeType),
    logoUrl: toolkitLogoUrl(toolkits, meta.toolkitSlug),
  };
}

/**
 * Turn an endpoint failure into copy that says what to DO, not just what
 * broke. `makeRequest` surfaces the API's `{error}` body as the Error message,
 * so the two known failure modes are matched by their exact text.
 */
export function describeComposioSearchError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Composio is not configured")) {
    return "Composio isn't enabled for this workspace. Ask an admin to add the Composio API key, then try again.";
  }
  if (message.startsWith("Failed to search Composio")) {
    return "We couldn't reach Composio. Check your connection and try again — if it keeps failing, Composio may be down.";
  }
  return `Search failed (${message}). Please try again.`;
}

/**
 * Empty-state heading. `toolkitName` only applies to tools: the filter is
 * per-toolkit, triggers search the whole catalog.
 */
export function emptyStateMessage(
  mode: ComposioResultMode,
  query: string,
  toolkitName?: string
): string {
  const noun = mode === "tools" ? "tools" : "triggers";
  const trimmed = query.trim();
  if (!trimmed) return `No ${noun} found.`;
  const scope = mode === "tools" && toolkitName ? ` in ${toolkitName}` : "";
  return `No ${noun} match "${trimmed}"${scope}.`;
}

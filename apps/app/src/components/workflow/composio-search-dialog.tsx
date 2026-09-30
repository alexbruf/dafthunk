import type { NodeType } from "@dafthunk/types";
import LoaderCircle from "lucide-react/icons/loader-circle";
import Search from "lucide-react/icons/search";
import {
  forwardRef,
  type KeyboardEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useComposioToolkits } from "@/integrations/hooks/use-composio-toolkits";
import {
  useComposioTools,
  useDebouncedValue,
} from "@/integrations/hooks/use-composio-tools";
import {
  type ComposioResultMode,
  type ComposioSearchRow,
  describeComposioSearchError,
  emptyStateMessage,
  shapeComposioResult,
} from "@/services/composio-service";
import { highlightMatch } from "@/utils/text-highlight";
import { cn } from "@/utils/utils";

import { SubscriptionBadge } from "./subscription-badge";

/** Sentinel select value meaning "no toolkit filter". Radix forbids empty item values. */
const ALL_TOOLKITS = "__all__";

const SEARCH_DEBOUNCE_MS = 250;

interface ComposioSearchDialogProps {
  open: boolean;
  onClose: () => void;
  onSelect: (nodeType: NodeType) => void;
  /** One trigger node per workflow; hides the trigger results when set. */
  hasTriggerNode?: boolean;
}

/**
 * Toolkit logo, falling back to an initial-letter tile. Search spans ~45,000
 * tools across 1,069 toolkits while `/composio/connect/toolkits` only covers
 * the ones Composio can broker auth for, so most results legitimately have no
 * image.
 */
function ToolkitLogo({ row }: { row: ComposioSearchRow }) {
  if (row.logoUrl) {
    return (
      <img
        src={row.logoUrl}
        alt=""
        className="h-9 w-9 rounded-md object-contain bg-card ring-1 ring-border shrink-0"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="h-9 w-9 rounded-md bg-muted ring-1 ring-border shrink-0 flex items-center justify-center text-xs font-semibold text-muted-foreground"
    >
      {row.toolkitName.charAt(0)}
    </span>
  );
}

interface ResultRowProps {
  row: ComposioSearchRow;
  query: string;
  mode: ComposioResultMode;
  focused: boolean;
  onFocus: () => void;
  onPick: () => void;
}

const ResultRow = forwardRef<HTMLButtonElement, ResultRowProps>(
  ({ row, query, mode, focused, onFocus, onPick }, ref) => (
    <button
      ref={ref}
      type="button"
      role="option"
      aria-selected={focused}
      onFocus={onFocus}
      onClick={onPick}
      className={cn(
        "w-full text-left border rounded-lg cursor-pointer bg-card px-3 py-3 transition-colors",
        focused ? "border-primary" : "border-border hover:border-primary/50"
      )}
    >
      <span className="flex items-start gap-3 min-w-0">
        <ToolkitLogo row={row} />
        <span className="flex-1 min-w-0">
          <span className="flex items-center gap-2">
            <span className="font-semibold text-sm leading-tight truncate">
              {highlightMatch(row.nodeType.name, query)}
            </span>
            {row.nodeType.subscription && (
              <SubscriptionBadge variant="muted" size="sm" />
            )}
          </span>
          <span className="block text-xs text-muted-foreground mt-0.5">
            {row.toolkitName}
            <span aria-hidden="true"> · </span>
            {mode === "tools" ? "Action" : "Trigger"}
          </span>
          {row.nodeType.description && (
            <span className="block text-sm text-muted-foreground leading-relaxed mt-1 line-clamp-2">
              {highlightMatch(row.nodeType.description, query)}
            </span>
          )}
        </span>
      </span>
    </button>
  )
);

export function ComposioSearchDialog({
  open,
  onClose,
  onSelect,
  hasTriggerNode = false,
}: ComposioSearchDialogProps) {
  const [mode, setMode] = useState<ComposioResultMode>("tools");
  const [query, setQuery] = useState("");
  const [toolkit, setToolkit] = useState(ALL_TOOLKITS);
  const [focusedIndex, setFocusedIndex] = useState(0);

  // The dialog renders before it opens (Radix keeps it mounted to animate),
  // so the debounced query starts from the box's initial value; the first
  // on-screen query only fires once the user settles on a term.
  const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);

  // Toolkit list is shared state across both tabs — triggers need logos too,
  // and the tools tab's filter reuses the same catalog the connect dialog
  // offers (the ones whose actions can actually run).
  const { toolkits = [] } = useComposioToolkits(open);

  const tools = useComposioTools({
    mode: "tools",
    query: debouncedQuery,
    toolkit: toolkit === ALL_TOOLKITS ? undefined : toolkit,
    enabled: open && mode === "tools",
  });
  // One trigger node per workflow, so with one already placed the triggers
  // tab only explains that — fetching a page it cannot display would waste a
  // round-trip every time the tab is opened.
  const triggers = useComposioTools({
    mode: "triggers",
    query: debouncedQuery,
    enabled: open && mode === "triggers" && !hasTriggerNode,
  });

  const active = mode === "tools" ? tools : triggers;

  const rows = useMemo(
    () =>
      active.nodeTypes.map((nodeType) =>
        shapeComposioResult(nodeType, toolkits)
      ),
    [active.nodeTypes, toolkits]
  );

  const selectedToolkitName = useMemo(
    () => toolkits.find((t) => t.slug === toolkit)?.name,
    [toolkits, toolkit]
  );

  const itemRefs = useRef<Record<number, HTMLButtonElement | null>>({});

  // The focused index may outlive a shrink (tab switch, new query, filter) —
  // clamping at render keeps the highlight on a row that exists without
  // needing an effect to reconcile it.
  const safeFocusedIndex = Math.min(focusedIndex, Math.max(0, rows.length - 1));

  const focusItem = (index: number) => {
    const clamped = Math.max(0, Math.min(index, rows.length - 1));
    setFocusedIndex(clamped);
    itemRefs.current[clamped]?.focus();
    itemRefs.current[clamped]?.scrollIntoView({ block: "nearest" });
  };

  const handleModeChange = (value: string) => {
    setMode(value as ComposioResultMode);
    setFocusedIndex(0);
  };

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // ArrowDown from the box moves straight into the first result — the one
    // interaction the browser doesn't give a plain input.
    if (event.key === "ArrowDown" && rows.length > 0) {
      event.preventDefault();
      focusItem(0);
    }
  };

  const handleListKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusItem(safeFocusedIndex + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        focusItem(safeFocusedIndex - 1);
        break;
      case "Home":
        event.preventDefault();
        focusItem(0);
        break;
      case "End":
        event.preventDefault();
        focusItem(rows.length - 1);
        break;
    }
  };

  const pick = (row: ComposioSearchRow) => {
    onSelect(row.nodeType);
    onClose();
  };

  const noun = mode === "tools" ? "tool" : "trigger";
  const resultsListId = "composio-search-results";

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="w-[80vw] h-[80vh] max-w-[1100px] flex flex-col p-0">
        <DialogTitle className="sr-only">
          Add a Composio tool or trigger
        </DialogTitle>
        <DialogDescription className="sr-only">
          Search Composio&apos;s catalog of tools and triggers, then add a
          result to your workflow.
        </DialogDescription>

        <div className="px-4 pt-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <Tabs value={mode} onValueChange={handleModeChange}>
              <TabsList aria-label="Result type">
                <TabsTrigger value="tools">Actions</TabsTrigger>
                <TabsTrigger value="triggers">Triggers</TabsTrigger>
              </TabsList>
            </Tabs>

            {mode === "tools" && (
              <Select
                value={toolkit}
                onValueChange={(value) => {
                  setToolkit(value);
                  setFocusedIndex(0);
                }}
              >
                <SelectTrigger className="w-56 h-9 text-sm">
                  <SelectValue placeholder="All toolkits" />
                </SelectTrigger>
                <SelectContent className="max-h-80">
                  <SelectItem value={ALL_TOOLKITS}>All toolkits</SelectItem>
                  {toolkits.map((toolkitOption) => (
                    <SelectItem
                      key={toolkitOption.slug}
                      value={toolkitOption.slug}
                    >
                      {toolkitOption.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              autoFocus
              aria-label={`Search Composio ${noun}s`}
              aria-controls={resultsListId}
              placeholder={
                mode === "tools"
                  ? 'Search tools, e.g. "create a github issue"…'
                  : 'Search triggers, e.g. "star added"…'
              }
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={handleSearchKeyDown}
              className="pl-9 h-11 border rounded-lg bg-accent text-sm"
            />
          </div>
        </div>

        {mode === "triggers" && hasTriggerNode ? (
          <div className="flex-1 flex items-center justify-center px-8">
            <Badge variant="secondary" className="px-4 py-2 text-sm">
              This workflow already has a trigger. Delete it first, or add an
              action instead.
            </Badge>
          </div>
        ) : active.isLoading && rows.length === 0 ? (
          <div className="flex-1 px-4 pt-2 space-y-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-16 w-full rounded-lg" />
            ))}
            <p className="text-xs text-muted-foreground text-center pt-2">
              Searching Composio…
            </p>
          </div>
        ) : active.error && rows.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 px-8">
            <p className="text-sm text-destructive text-center max-w-md">
              {describeComposioSearchError(active.error)}
            </p>
            <Button variant="outline" size="sm" onClick={active.reload}>
              Try again
            </Button>
          </div>
        ) : (
          <ScrollArea className="flex-1 min-h-0">
            <ul
              id={resultsListId}
              role="listbox"
              aria-label={`${noun} results`}
              onKeyDown={handleListKeyDown}
              className="space-y-2 px-4 py-2"
            >
              {rows.map((row, index) => (
                <li key={row.nodeType.id} className="list-none">
                  <ResultRow
                    row={row}
                    query={query}
                    mode={mode}
                    focused={index === safeFocusedIndex}
                    onFocus={() => setFocusedIndex(index)}
                    onPick={() => pick(row)}
                    ref={(element) => {
                      itemRefs.current[index] = element;
                    }}
                  />
                </li>
              ))}
              {rows.length === 0 && !active.error && (
                <li className="list-none text-center py-16 px-6">
                  <p className="text-sm font-medium">
                    {emptyStateMessage(
                      mode,
                      query,
                      mode === "tools" ? selectedToolkitName : undefined
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {mode === "tools"
                      ? "Try a broader term, or drop the toolkit filter if one is set."
                      : 'Try searching for the app instead, like "github" or "gmail".'}
                  </p>
                </li>
              )}
            </ul>
          </ScrollArea>
        )}

        <div className="flex items-center justify-between px-4 pb-3 pt-1 text-xs text-muted-foreground/70">
          <span className="flex items-center gap-2">
            {rows.length > 0 &&
              `${rows.length} result${rows.length === 1 ? "" : "s"}`}
            {active.isRefreshing && rows.length > 0 && (
              <span className="inline-flex items-center gap-1">
                <LoaderCircle className="h-3 w-3 animate-spin" />
                Searching…
              </span>
            )}
          </span>
          {active.nextCursor && (
            <Button
              variant="outline"
              size="sm"
              onClick={active.loadMore}
              disabled={active.isLoadingMore}
            >
              {active.isLoadingMore && (
                <LoaderCircle className="h-3.5 w-3.5 mr-1 animate-spin" />
              )}
              Load more
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

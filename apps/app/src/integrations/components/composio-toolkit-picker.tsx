import Check from "lucide-react/icons/check";
import Plug from "lucide-react/icons/plug";
import { useState } from "react";

import { ScrollArea } from "@/components/ui/scroll-area";
import { SearchInput } from "@/components/ui/search-input";
import { cn } from "@/utils/utils";

import type { ComposioToolkit } from "../hooks/use-composio-toolkits";

interface ComposioToolkitPickerProps {
  toolkits: ComposioToolkit[] | undefined;
  isLoading: boolean;
  hasError: boolean;
  selectedSlug: string | null;
  onSelect: (slug: string) => void;
}

function matches(toolkit: ComposioToolkit, needle: string): boolean {
  if (!needle) return true;
  const term = needle.toLowerCase();
  return (
    toolkit.name.toLowerCase().includes(term) ||
    toolkit.slug.toLowerCase().includes(term)
  );
}

/**
 * Presentational: the catalog is fetched once by the dialog, which also needs
 * it to decide whether to offer Composio at all.
 */
export function ComposioToolkitPicker({
  toolkits,
  isLoading,
  hasError,
  selectedSlug,
  onSelect,
}: ComposioToolkitPickerProps) {
  const [search, setSearch] = useState("");

  // Derived on every render rather than stored: there is no second copy of the
  // catalog that could drift from the fetched one.
  const visible = (toolkits ?? []).filter((toolkit) =>
    matches(toolkit, search)
  );

  if (hasError) {
    return (
      <p className="text-sm text-red-600">
        Composio is unavailable right now. Please try again later.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <SearchInput
        placeholder="Search apps (Gmail, Slack, Notion...)"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />

      <ScrollArea className="h-72 rounded-md border">
        {isLoading ? (
          <p className="p-3 text-sm text-muted-foreground">Loading apps...</p>
        ) : visible.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">
            No app matches this search.
          </p>
        ) : (
          <ul className="p-1">
            {visible.map((toolkit) => (
              <li key={toolkit.slug}>
                <button
                  type="button"
                  onClick={() => onSelect(toolkit.slug)}
                  className={cn(
                    "flex w-full items-start gap-3 rounded-md px-2 py-2 text-left text-sm hover:bg-accent",
                    selectedSlug === toolkit.slug && "bg-accent"
                  )}
                >
                  {toolkit.logo ? (
                    <img
                      src={toolkit.logo}
                      alt=""
                      className="size-5 shrink-0 rounded-sm"
                    />
                  ) : (
                    <Plug className="size-5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{toolkit.name}</span>
                    {toolkit.description && (
                      // Wrapped and clamped rather than truncated to one line:
                      // these descriptions are a sentence or two, and a single
                      // ellipsed line hid which app a row was for. Two lines
                      // keeps every row the same height, so the list stays
                      // scannable instead of turning into a long scroll.
                      <span className="mt-0.5 block line-clamp-2 whitespace-normal text-xs leading-snug text-muted-foreground">
                        {toolkit.description}
                      </span>
                    )}
                  </span>
                  {selectedSlug === toolkit.slug && (
                    <Check className="size-4 shrink-0" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>
    </div>
  );
}

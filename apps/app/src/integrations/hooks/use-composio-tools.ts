import type { NodeType } from "@dafthunk/types";
import { useCallback, useEffect, useMemo, useState } from "react";
import useSWRInfinite from "swr/infinite";

import {
  buildComposioSearchQuery,
  type ComposioResultMode,
  type ComposioSearchPage,
} from "@/services/composio-service";
import { makeRequest } from "@/services/utils";

/**
 * Debounce a changing value (the dialog's raw search text) so the per-
 * keystroke round-trip only fires once the user settles.
 *
 * This is the one justified `useEffect` in the search path: debouncing is
 * timer-driven by nature, so it cannot be a pure derivation.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export interface UseComposioToolsOptions {
  mode: ComposioResultMode;
  /** Debounced query — call `useDebouncedValue` before passing it in. */
  query: string;
  /** Toolkit slug for the tools mode; ignored by triggers. */
  toolkit?: string;
  /** Set false when the dialog is closed so nothing is fetched. */
  enabled: boolean;
}

export interface UseComposioToolsResult {
  nodeTypes: NodeType[];
  /** First page has never loaded for the current query. */
  isLoading: boolean;
  /** A "load more" page is in flight. */
  isLoadingMore: boolean;
  /** A newer fetch is refreshing already-shown results (typing in progress). */
  isRefreshing: boolean;
  error: Error | undefined;
  nextCursor: string | null;
  loadMore: () => void;
  reload: () => void;
}

/**
 * Paged search of the Composio catalog, one hook per result mode.
 *
 * Each page is its own SWR entry keyed by its cursor, so "load more" appends
 * without any manual result-buffer state: `nodeTypes` is derived by flattening
 * the fetched pages. `keepPreviousData` keeps the last page set on screen
 * while a new query's first page loads, so retyping never flashes the list
 * away.
 */
export function useComposioTools({
  mode,
  query,
  toolkit,
  enabled,
}: UseComposioToolsOptions): UseComposioToolsResult {
  const endpoint = enabled
    ? buildComposioSearchQuery({ mode, query, toolkit })
    : null;

  const getKey = useCallback(
    (index: number, previousPage: ComposioSearchPage | null) => {
      if (!endpoint) return null;
      if (index === 0) return endpoint;
      const cursor = previousPage?.nextCursor ?? null;
      if (!cursor) return null;
      // Page cursors are opaque tokens scoped to the search that produced
      // them, so every page is keyed by the full query it extends.
      return buildComposioSearchQuery({ mode, query, toolkit, cursor });
    },
    [endpoint, mode, query, toolkit]
  );

  const { data, error, isLoading, isValidating, size, setSize, mutate } =
    useSWRInfinite<ComposioSearchPage>(
      getKey,
      (url: string) => makeRequest<ComposioSearchPage>(url),
      {
        keepPreviousData: true,
        revalidateOnFocus: false,
        dedupingInterval: 30_000,
      }
    );

  const nodeTypes = useMemo(
    () => (data ?? []).flatMap((page) => page.nodeTypes),
    [data]
  );

  // SWR reports "no data for the current key" both before the first fetch and
  // while a fast-typed query's fetch is still in flight; with
  // `keepPreviousData` the latter keeps the stale pages around, so only the
  // truly-empty case is a loading state for the dialog to render.
  const lastPage = data?.[data.length - 1];
  const isLoadingMore =
    size > 0 && data != null && data[size - 1] === undefined;

  const loadMore = useCallback(() => {
    setSize((current) => current + 1);
  }, [setSize]);

  const reload = useCallback(() => {
    void mutate();
  }, [mutate]);

  return {
    nodeTypes,
    isLoading: isLoading && nodeTypes.length === 0,
    isLoadingMore,
    isRefreshing: isValidating && !isLoadingMore,
    error,
    nextCursor: lastPage?.nextCursor ?? null,
    loadMore,
    reload,
  };
}

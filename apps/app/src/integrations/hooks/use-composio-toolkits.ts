import useSWR from "swr";

import { makeRequest } from "@/services/utils";

const API_ENDPOINT = "/composio/connect/toolkits";

export interface ComposioToolkit {
  slug: string;
  name: string;
  description: string;
  logo: string;
}

interface ComposioToolkitsResponse {
  toolkits: ComposioToolkit[];
}

export interface UseComposioToolkitsResult {
  toolkits: ComposioToolkit[] | undefined;
  error: Error | undefined;
  isLoading: boolean;
  /**
   * Whether Composio is usable at all. The endpoint answers 503 when
   * `COMPOSIO_API_KEY` is unset, which doubles as the availability probe —
   * `/integrations/providers` only reports providers whose OAuth client
   * credentials Dafthunk owns, and Composio has none.
   */
  isAvailable: boolean;
}

/**
 * Lists the toolkits Composio can broker a connection for.
 *
 * Not organization-scoped: the catalog is identical for every tenant, and the
 * endpoint sits beside the connect flow rather than under `/:organizationId`.
 * `enabled` gates the request on the integrations dialog actually being open.
 */
export function useComposioToolkits(
  enabled: boolean
): UseComposioToolkitsResult {
  const { data, error, isLoading } = useSWR(
    enabled ? API_ENDPOINT : null,
    enabled
      ? async () => {
          const response =
            await makeRequest<ComposioToolkitsResponse>(API_ENDPOINT);
          return response.toolkits;
        }
      : null
  );

  return {
    toolkits: data,
    error,
    isLoading,
    isAvailable: !error && (data?.length ?? 0) > 0,
  };
}

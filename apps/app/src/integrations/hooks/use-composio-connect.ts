import { useCallback } from "react";
import { toast } from "sonner";

import { useAuth } from "@/components/auth-context";
import { getApiBaseUrl } from "@/config/api";

interface UseComposioConnectResult {
  connectToolkit: (toolkitSlug: string) => void;
}

/**
 * Sends the browser to Composio's hosted auth link.
 *
 * A full navigation rather than a fetch: the API answers with a redirect to
 * Composio's own domain, and the user has to complete the upstream provider's
 * consent screen there before being redirected back to `/composio/callback`.
 */
export function useComposioConnect(): UseComposioConnectResult {
  const { organization } = useAuth();
  const organizationId = organization?.id;

  const connectToolkit = useCallback(
    (toolkitSlug: string) => {
      if (!organizationId) {
        toast.error("No organization selected");
        return;
      }

      const params = new URLSearchParams({
        toolkit: toolkitSlug,
        organizationId,
      });
      window.location.href = `${getApiBaseUrl()}/composio/connect?${params}`;
    },
    [organizationId]
  );

  return { connectToolkit };
}

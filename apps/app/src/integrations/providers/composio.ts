import Plug from "lucide-react/icons/plug";

import type { ProviderConfig } from "../types";

/**
 * Composio is not an OAuth provider Dafthunk owns credentials for — it brokers
 * connections to hundreds of toolkits on our behalf. Connecting goes through a
 * hosted auth link rather than `/oauth/:provider/connect`, so `supportsOAuth`
 * is false and the connect flow lives at its own endpoint.
 */
export const composioProvider: ProviderConfig = {
  id: "composio",
  name: "Composio",
  description:
    "Connect any of hundreds of apps through Composio to use their actions and triggers",
  icon: Plug,
  supportsOAuth: false,
  successMessage: "Composio connection added successfully",
};

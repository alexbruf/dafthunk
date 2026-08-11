import type { IntegrationProvider } from "@dafthunk/types";
import ExternalLink from "lucide-react/icons/external-link";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { useAvailableProviders } from "../hooks/use-available-providers";
import { useComposioConnect } from "../hooks/use-composio-connect";
import { useComposioToolkits } from "../hooks/use-composio-toolkits";
import { useIntegrationActions } from "../hooks/use-integration-actions";
import {
  getAvailableProviders,
  getProvider,
  getProviderLabel,
} from "../providers";
import { ComposioToolkitPicker } from "./composio-toolkit-picker";

/**
 * Composio is neither an OAuth provider nor an API-key one: the user picks a
 * toolkit and Dafthunk hands them to Composio's hosted auth link, so this
 * dialog needs a third branch rather than a new flag on `ProviderConfig`.
 */
const COMPOSIO_PROVIDER: IntegrationProvider = "composio";

interface IntegrationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function IntegrationDialog({
  open,
  onOpenChange,
}: IntegrationDialogProps) {
  const { isProcessing, connectOAuth, createManual } = useIntegrationActions();
  const { connectToolkit } = useComposioConnect();
  const { providers: availableProviderIds, isLoading: isLoadingProviders } =
    useAvailableProviders();
  const {
    toolkits,
    isLoading: isLoadingToolkits,
    error: toolkitsError,
    isAvailable: isComposioAvailable,
  } = useComposioToolkits(open);

  const [selectedProvider, setSelectedProvider] =
    useState<IntegrationProvider | null>(null);
  const [integrationName, setIntegrationName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [composioToolkit, setComposioToolkit] = useState<string | null>(null);

  // Memoize providers list
  const providers = useMemo(() => {
    const configured =
      availableProviderIds && availableProviderIds.length > 0
        ? getAvailableProviders(availableProviderIds)
        : [];

    // `/integrations/providers` reports providers whose OAuth client
    // credentials Dafthunk holds. Composio has none to hold — its own catalog
    // endpoint answering is what proves it is configured.
    const composio = getProvider(COMPOSIO_PROVIDER);
    if (
      !isComposioAvailable ||
      !composio ||
      configured.some((provider) => provider.id === COMPOSIO_PROVIDER)
    ) {
      return configured;
    }
    return [...configured, composio];
  }, [availableProviderIds, isComposioAvailable]);

  // Memoize current provider
  const currentProvider = useMemo(
    () => providers.find((p) => p.id === selectedProvider),
    [providers, selectedProvider]
  );

  // Set default provider when providers load
  useEffect(() => {
    if (!selectedProvider && providers.length > 0) {
      setSelectedProvider(providers[0].id);
    }
  }, [providers, selectedProvider]);

  // Reset form state
  const resetForm = () => {
    setIntegrationName("");
    setApiKey("");
    setComposioToolkit(null);
    setSelectedProvider(providers.length > 0 ? providers[0].id : null);
  };

  const handleClose = () => {
    onOpenChange(false);
    resetForm();
  };

  const handleConnect = async () => {
    if (!currentProvider || !selectedProvider) return;

    if (selectedProvider === COMPOSIO_PROVIDER) {
      if (!composioToolkit) return;
      connectToolkit(composioToolkit);
      handleClose();
      return;
    }

    if (currentProvider.supportsOAuth) {
      connectOAuth(selectedProvider);
      handleClose();
    } else {
      if (!integrationName || !apiKey) return;

      try {
        await createManual(selectedProvider, integrationName, apiKey);
        handleClose();
      } catch {
        // Error is already handled in the hook
      }
    }
  };

  // Determine dialog content based on state
  let content: React.ReactNode;
  let footer: React.ReactNode;

  if (isLoadingProviders) {
    content = (
      <DialogDescription>Loading available providers...</DialogDescription>
    );
  } else if (providers.length === 0) {
    content = (
      <DialogDescription>
        No integration providers are currently configured. Please contact your
        administrator.
      </DialogDescription>
    );
    footer = <Button onClick={handleClose}>Close</Button>;
  } else {
    const isComposio = selectedProvider === COMPOSIO_PROVIDER;
    const isOAuth = currentProvider?.supportsOAuth;
    const canSubmit = isComposio
      ? Boolean(composioToolkit)
      : isOAuth || Boolean(integrationName && apiKey);

    content = (
      <>
        <DialogDescription>
          Connect a third-party service to your organization.
        </DialogDescription>
        <div className="space-y-4">
          <div>
            <Label htmlFor="provider">Provider</Label>
            <Select
              value={selectedProvider || undefined}
              onValueChange={(value) =>
                setSelectedProvider(value as IntegrationProvider)
              }
            >
              <SelectTrigger id="provider">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {providers.map((provider) => (
                  <SelectItem key={provider.id} value={provider.id}>
                    {provider.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-sm text-muted-foreground mt-2">
              {currentProvider?.description}
            </p>
          </div>

          {isComposio && (
            <div>
              <Label>App</Label>
              <ComposioToolkitPicker
                toolkits={toolkits}
                isLoading={isLoadingToolkits}
                hasError={Boolean(toolkitsError)}
                selectedSlug={composioToolkit}
                onSelect={setComposioToolkit}
              />
            </div>
          )}

          {!isOAuth && !isComposio && (
            <>
              {currentProvider?.apiKeyInstructions && (
                <div className="rounded-lg border bg-muted/50 p-3">
                  <p className="text-sm text-muted-foreground">
                    {currentProvider.apiKeyInstructions}
                  </p>
                  {currentProvider.apiKeyUrl && (
                    <Button
                      variant="link"
                      className="h-auto p-0 mt-2 text-xs"
                      asChild
                    >
                      <a
                        href={currentProvider.apiKeyUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Get API Key
                        <ExternalLink className="ml-1 h-3 w-3" />
                      </a>
                    </Button>
                  )}
                </div>
              )}
              <div>
                <Label htmlFor="integration-name">Integration Name</Label>
                <Input
                  id="integration-name"
                  placeholder="e.g., Production Key"
                  value={integrationName}
                  onChange={(e) => setIntegrationName(e.target.value)}
                />
                <p className="text-sm text-muted-foreground mt-1">
                  Will be saved as:{" "}
                  {selectedProvider
                    ? getProviderLabel(selectedProvider)
                    : "..."}{" "}
                  - {integrationName || "..."}
                </p>
              </div>
              <div>
                <Label htmlFor="api-key">API Key</Label>
                <Input
                  id="api-key"
                  type="password"
                  placeholder="Enter your API key"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
              </div>
            </>
          )}
        </div>
      </>
    );

    footer = (
      <>
        <Button variant="outline" onClick={handleClose}>
          Cancel
        </Button>
        <Button onClick={handleConnect} disabled={isProcessing || !canSubmit}>
          {isProcessing
            ? "Processing..."
            : isOAuth || isComposio
              ? "Connect"
              : "Add Integration"}
        </Button>
      </>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* The Composio branch adds a provider blurb, a search box and a list of
          ~1,000 toolkits, which together outgrow the viewport. shadcn's
          DialogContent sets no height bound, so without this the dialog runs
          off the screen instead of scrolling. */}
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add Integration</DialogTitle>
          {content}
        </DialogHeader>
        {footer && <DialogFooter>{footer}</DialogFooter>}
      </DialogContent>
    </Dialog>
  );
}

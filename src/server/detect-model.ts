/**
 * Detect the current model and provider from the user's Hermes config.
 *
 * Reads ~/.hermes/config.yaml and extracts the default model,
 * provider, base_url, and api_mode settings.
 *
 * Also provides provider resolution logic that merges explicit config,
 * Hermes config detection, and model-name prefix inference.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { MODEL_PREFIX_PROVIDER_HINTS, VALID_PROVIDERS } from "../shared/constants.js";

export interface DetectedModel {
  /** Model name from config (e.g. "gpt-5.4", "anthropic/claude-sonnet-4") */
  model: string;
  /** Provider name from config (e.g. "copilot", "zai"). May be empty. */
  provider: string;
  /** Base URL override from config (e.g. "https://api.githubcopilot.com"). May be empty. */
  baseUrl: string;
  /** API mode from config (e.g. "chat_completions", "codex_responses"). May be empty. */
  apiMode: string;
  /** Where the detection came from */
  source: "config";
}

/**
 * Read the Hermes config file and extract the default model config.
 */
export async function detectModel(
  configPath?: string,
): Promise<DetectedModel | null> {
  const filePath = configPath ?? join(homedir(), ".hermes", "config.yaml");

  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return null;
  }

  return parseModelFromConfig(content);
}

/**
 * Parse model.default, model.provider, model.base_url, and model.api_mode
 * from raw YAML content. Uses simple regex parsing to avoid a YAML dependency.
 */
export function parseModelFromConfig(content: string): DetectedModel | null {
  const lines = content.split("\n");
  let model = "";
  let provider = "";
  let baseUrl = "";
  let apiMode = "";
  let inModelSection = false;
  let modelSectionIndent = 0;

  for (const line of lines) {
    const trimmed = line.trimEnd();
    const indent = line.length - line.trimStart().length;

    // Track model: section (indent 0)
    if (/^model:\s*$/.test(trimmed) && indent === 0) {
      inModelSection = true;
      modelSectionIndent = 0;
      continue;
    }

    // We left the model section if indent drops back to the section level or below
    if (inModelSection && indent <= modelSectionIndent && trimmed && !trimmed.startsWith("#")) {
      inModelSection = false;
    }

    if (inModelSection) {
      const match = trimmed.match(/^\s*(\w+)\s*:\s*(.+)$/);
      if (match) {
        const key = match[1];
        const val = match[2].trim().replace(/#.*$/, "").trim().replace(/^['"]|['"]$/g, "");
        if (key === "default") model = val;
        if (key === "provider") provider = val;
        if (key === "base_url") baseUrl = val;
        if (key === "api_mode") apiMode = val;
      }
    }
  }

  if (!model) return null;

  return { model, provider, baseUrl, apiMode, source: "config" };
}

/**
 * Infer a provider from the model name using prefix-based hints.
 *
 * For example:
 *   "gpt-5.4"       → "copilot"
 *   "claude-sonnet-4" → "anthropic"
 *   "glm-5-turbo"   → "zai"
 *
 * Returns undefined if no hint matches (caller should fall back to "auto").
 */
export function inferProviderFromModel(model: string): string | undefined {
  const lower = model.toLowerCase();

  // Strip provider/ prefix if present (e.g. "anthropic/claude-sonnet-4")
  const bareName = lower.includes("/") ? lower.split("/").pop()! : lower;

  for (const [prefix, hint] of MODEL_PREFIX_PROVIDER_HINTS) {
    if (bareName.startsWith(prefix)) {
      return hint;
    }
  }

  return undefined;
}

/**
 * Resolve the correct provider for a model, using a priority chain:
 *
 *   1. Explicit provider from adapterConfig (highest priority — user override)
 *   2. Provider from Hermes config file — ONLY if the config model matches
 *      the requested model (otherwise the config provider is for a different model)
 *   3. Provider inferred from model name prefix
 *   4. "auto" (let Hermes figure it out — lowest priority)
 *
 * Always returns a valid provider string.
 * The `resolvedFrom` field indicates which source was used, useful for logging.
 */
export function resolveProvider(options: {
  /** Explicit provider from adapterConfig (user override) */
  explicitProvider?: string | null;
  /** Provider detected from Hermes config file */
  detectedProvider?: string;
  /** Model name from Hermes config file (to check consistency) */
  detectedModel?: string;
  /** Model name to infer from if no explicit/detected provider */
  model?: string;
}): { provider: string; resolvedFrom: string } {
  const { explicitProvider, detectedProvider, detectedModel, model } = options;

  // 1. Explicit provider from adapterConfig — user override, always wins
  if (explicitProvider && (VALID_PROVIDERS as readonly string[]).includes(explicitProvider)) {
    return { provider: explicitProvider, resolvedFrom: "adapterConfig" };
  }

  // 2. Provider from Hermes config file — but ONLY if the config model matches
  //    the requested model. Otherwise the config provider is for a different model
  //    and would cause exactly the kind of routing bug we're fixing.
  if (
    detectedProvider &&
    detectedModel &&
    (VALID_PROVIDERS as readonly string[]).includes(detectedProvider) &&
    // Config model matches requested model (exact or case-insensitive)
    detectedModel.toLowerCase() === model?.toLowerCase()
  ) {
    return { provider: detectedProvider, resolvedFrom: "hermesConfig" };
  }

  // 3. Infer from model name prefix
  if (model) {
    const inferred = inferProviderFromModel(model);
    if (inferred) {
      return { provider: inferred, resolvedFrom: "modelInference" };
    }
  }

  // 4. Let Hermes auto-detect
  return { provider: "auto", resolvedFrom: "auto" };
}

// ---- Custom Providers Support ----

export interface CustomProvider {
  name: string;
  baseUrl: string;
  apiKey: string;
  defaultModel?: string;
}

/**
 * Parse custom_providers section from Hermes config YAML.
 */
export function parseCustomProviders(content: string): CustomProvider[] {
  const lines = content.split("\n");
  const providers: CustomProvider[] = [];
  let inCustomProviders = false;
  let currentProvider: Partial<CustomProvider> | null = null;

  for (const line of lines) {
    const trimmed = line.trimEnd();
    const indent = line.length - line.trimStart().length;

    if (/^custom_providers:\s*$/.test(trimmed) && indent === 0) {
      inCustomProviders = true;
      continue;
    }

    if (inCustomProviders) {
      // Exit section if indent returns to 0 and line is not a list item
      if (indent === 0 && trimmed && !trimmed.startsWith("-") && !trimmed.startsWith("#")) {
        inCustomProviders = false;
        if (currentProvider?.name && currentProvider?.baseUrl) {
          providers.push(currentProvider as CustomProvider);
        }
        currentProvider = null;
        continue;
      }

      // New list item: "- name: litellm"
      const nameMatch = trimmed.match(/^-\s+name:\s*(.+)$/);
      if (nameMatch) {
        if (currentProvider?.name && currentProvider?.baseUrl) {
          providers.push(currentProvider as CustomProvider);
        }
        currentProvider = { name: nameMatch[1].trim() };
        continue;
      }

      if (currentProvider) {
        const kvMatch = trimmed.match(/^\s*(\w+)\s*:\s*(.+)$/);
        if (kvMatch) {
          const key = kvMatch[1];
          const val = kvMatch[2].trim().replace(/#.*$/, "").trim().replace(/^['"]|['"]$/g, "");
          if (key === "base_url") currentProvider.baseUrl = val;
          if (key === "api_key") currentProvider.apiKey = val;
          if (key === "model") currentProvider.defaultModel = val;
        }
      }
    }
  }

  if (currentProvider?.name && currentProvider?.baseUrl) {
    providers.push(currentProvider as CustomProvider);
  }

  return providers;
}

/**
 * Fetch available models from a custom provider's /v1/models endpoint
 * (OpenAI-compatible API).
 */
async function fetchModelsFromProvider(
  provider: CustomProvider,
): Promise<{ id: string; label: string }[]> {
  const url = provider.baseUrl.replace(/\/+$/, "") + "/models";
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (provider.apiKey) {
      headers["Authorization"] = `Bearer ${provider.apiKey}`;
    }
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return [];
    const data = (await resp.json()) as any;
    const models = data?.data;
    if (!Array.isArray(models)) return [];
    return models
      .filter((m: any) => m.id && typeof m.id === "string")
      .map((m: any) => ({ id: m.id, label: m.id }));
  } catch {
    return [];
  }
}

/**
 * List all available models from Hermes config (custom providers + default model).
 * This is the main entry point for Paperclip's listAdapterModels().
 */
export async function listModels(): Promise<{ id: string; label: string }[]> {
  const configPath = join(homedir(), ".hermes", "config.yaml");
  let content: string;
  try {
    content = await readFile(configPath, "utf-8");
  } catch {
    return [];
  }

  const customProviders = parseCustomProviders(content);
  const defaultConfig = parseModelFromConfig(content);

  const allModels: { id: string; label: string }[] = [];
  const seen = new Set<string>();

  // Add default model first
  if (defaultConfig?.model && !seen.has(defaultConfig.model)) {
    seen.add(defaultConfig.model);
    allModels.push({ id: defaultConfig.model, label: defaultConfig.model });
  }

  // Fetch from custom providers in parallel
  const providerPromises = customProviders.map(async (provider) => {
    const models = await fetchModelsFromProvider(provider);
    // Also add the provider's default model if specified
    if (provider.defaultModel && !seen.has(provider.defaultModel)) {
      seen.add(provider.defaultModel);
      allModels.push({ id: provider.defaultModel, label: provider.defaultModel });
    }
    return models;
  });

  const results = await Promise.all(providerPromises);
  for (const models of results) {
    for (const model of models) {
      if (!seen.has(model.id)) {
        seen.add(model.id);
        allModels.push(model);
      }
    }
  }

  return allModels;
}

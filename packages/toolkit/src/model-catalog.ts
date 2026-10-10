export type CatalogModel = {
  disabled?: boolean;
  name: string;
  package: '@opencode/ai/providers/openai' | '@opencode/ai/providers/anthropic' | '@opencode/ai/providers/openai-compatible';
  capabilities: { tools: boolean; input: string[]; output: string[] };
  limit: { context: number; input?: number; output: number };
  websocket: false;
};

/** Public model selection supplied by the host: never a credential, and the only models the editor offers. */
export interface ModelCatalog { models: Record<string, CatalogModel>; defaultModel: string }

const fields = ['disabled', 'name', 'package', 'capabilities', 'limit', 'websocket'];
const packages = ['@opencode/ai/providers/openai', '@opencode/ai/providers/anthropic', '@opencode/ai/providers/openai-compatible'];
const strings = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === 'string');
const size = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0;

/** Validate an untrusted catalog document (e.g. a JSON file) before it is delivered to browsers and guests. */
export function parseModelCatalog(input: unknown): ModelCatalog {
  const catalog = input as Partial<ModelCatalog> | null;
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) throw Error('Model catalog must be an object with models and defaultModel');
  if (typeof catalog.defaultModel !== 'string' || !catalog.defaultModel) throw Error('Explicit catalog requires a default model');
  const models = catalog.models;
  if (!models || typeof models !== 'object' || Array.isArray(models) || !Object.keys(models).length) throw Error('Model catalog requires at least one model');
  for (const [id, model] of Object.entries(models) as [string, Record<string, unknown> | null][]) {
    const invalid = (reason: string) => Error(`Model catalog entry ${JSON.stringify(id.slice(0, 100))}: ${reason}`);
    if (!/^[\w./:-]{1,128}$/.test(id)) throw invalid('invalid model identifier');
    if (!model || typeof model !== 'object' || Array.isArray(model)) throw invalid('expected an object');
    // The catalog is published to the browser and the guest. Settings, headers
    // and bodies could carry credentials, so only the public fields are accepted.
    const unknown = Object.keys(model).find(field => !fields.includes(field));
    if (unknown) throw invalid(`unsupported field ${JSON.stringify(unknown.slice(0, 100))}`);
    if (typeof model.name !== 'string' || !model.name) throw invalid('expected a name');
    if (!packages.includes(model.package as string)) throw invalid('unsupported provider package');
    const capabilities = model.capabilities as Record<string, unknown> | undefined, limit = model.limit as Record<string, unknown> | undefined;
    if (typeof capabilities?.tools !== 'boolean' || !strings(capabilities.input) || !strings(capabilities.output)) throw invalid('expected capabilities {tools, input, output}');
    if (!size(limit?.context) || !size(limit?.output) || (limit?.input !== undefined && !size(limit.input))) throw invalid('expected limit {context, input?, output}');
    if (model.websocket !== false) throw invalid('expected websocket: false');
    if (model.disabled !== undefined && typeof model.disabled !== 'boolean') throw invalid('expected a boolean disabled');
  }
  const { defaultModel } = catalog, supplied = models as Record<string, CatalogModel>;
  if (!Object.hasOwn(supplied, defaultModel)) throw Error('Default model is absent from the supplied catalog');
  const selected = supplied[defaultModel]!;
  if (selected.disabled || !selected.capabilities.tools) throw Error('Default model must be enabled with tools');
  return { models: supplied, defaultModel };
}

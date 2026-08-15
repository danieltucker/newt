/**
 * The providers Newt knows how to talk to, and the models each one offers.
 *
 * Three entries rather than one per vendor, because there are only two wire
 * formats worth writing an adapter for:
 *
 *   anthropic   the Messages API. Its own shape: `system` is a top-level
 *               field, content is a list of blocks, and the SSE deltas are
 *               named differently from everyone else's.
 *   openai      /v1/chat/completions.
 *   compatible  the same /v1/chat/completions shape, at a base URL the user
 *               supplies. This one entry is what makes Ollama, OpenWebUI,
 *               LM Studio, vLLM, OpenRouter, Groq and Together work: they all
 *               serve the OpenAI format, so a bespoke adapter each would be
 *               four copies of the same file.
 *
 * `docsUrl` is shown next to the key field in settings. It is the page that
 * actually issues a key, not the vendor's home page: "where do I get one" is
 * the question that stops people, and a marketing site does not answer it.
 */

export type ProviderId = 'anthropic' | 'openai' | 'compatible';

/** Roughly what a model costs to run, for someone who does not follow model names. */
export type Tier = 'economy' | 'balanced' | 'premium';

export interface ModelOption {
  id: string;
  /** What a person calls it. */
  label: string;
  tier: Tier;
  /**
   * Indicative US dollars per million tokens, input and output.
   *
   * Shown so the picker can say "about 20x cheaper" without the reader
   * having to hold two price lists in their head. **Indicative is the
   * operative word** — vendors change prices, and this table is a snapshot
   * that only updates when Newt does, so the UI labels it as approximate and
   * links to the provider's own pricing page. Nothing bills off these numbers;
   * they exist to rank the options.
   */
  inputPer1M: number;
  outputPer1M: number;
  blurb: string;
  /**
   * Fit to be the utility model: the cheap one used for proofreading and for
   * working out what to search the feed for. See `utilityModelFor`.
   */
  utility?: boolean;
  /**
   * Whether the model accepts `output_config.effort`.
   *
   * Opt-in, and per model rather than per provider, because it is neither.
   * Anthropic added the effort parameter partway through the Claude 4 line: the
   * 5-series models take it, and Haiku 4.5 — which is the model *every* Claude
   * user's proofread and feed-search calls run on, whatever they picked — does
   * not, and rejects a request carrying it with a 400. Sending it is therefore
   * not a safe default, and a model added here later has to say it supports the
   * knob before Newt reaches for it. See `supportsEffort` and buildBody in chat.
   */
  effort?: boolean;
}

export interface Provider {
  id: ProviderId;
  label: string;
  /** 'anthropic' | 'openai': which adapter in chat.ts handles it. */
  wire: 'anthropic' | 'openai';
  /** Fixed endpoint. Empty for `compatible`, whose URL comes from the credential. */
  baseUrl: string;
  needsBaseUrl: boolean;
  /**
   * False for `compatible`: a locally hosted Ollama or LM Studio has no auth at
   * all, and demanding a key would lock out the most common self-host setup.
   */
  needsKey: boolean;
  models: ModelOption[];
  defaultModel: string;
  docsUrl: string;
  /** The vendor's own price list, which is authoritative over the table above. */
  pricingUrl: string;
  blurb: string;
  /**
   * Whether Newt can ask the endpoint what models it serves (GET /v1/models).
   * True only for `compatible`: the hosted providers have a known catalogue,
   * and a self-hosted box serves whatever it happens to have pulled.
   */
  canListModels: boolean;
}

export const PROVIDERS: Record<ProviderId, Provider> = {
  anthropic: {
    id: 'anthropic',
    label: 'Claude',
    wire: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    needsBaseUrl: false,
    needsKey: true,
    models: [
      {
        id: 'claude-opus-5',
        label: 'Claude Opus 5',
        tier: 'premium',
        inputPer1M: 5,
        outputPer1M: 25,
        blurb: 'The deepest reasoning, and the most expensive by a wide margin. Worth it for hard research; wasted on a proofread.',
        effort: true,
      },
      {
        id: 'claude-sonnet-5',
        label: 'Claude Sonnet 5',
        tier: 'balanced',
        inputPer1M: 3,
        outputPer1M: 15,
        blurb: 'Close to Opus on most work at a lower price. A good default.',
        effort: true,
      },
      {
        id: 'claude-haiku-4-5',
        label: 'Claude Haiku 4.5',
        tier: 'economy',
        inputPer1M: 1,
        outputPer1M: 5,
        blurb: 'Fastest and cheapest. Fine for proofreading and short questions.',
        utility: true,
        // No `effort`: Haiku 4.5 predates the parameter and 400s on it. This is
        // the line the proofreader was breaking on.
      },
    ],
    defaultModel: 'claude-sonnet-5',
    docsUrl: 'https://console.anthropic.com/settings/keys',
    pricingUrl: 'https://www.anthropic.com/pricing#api',
    blurb: 'Anthropic’s API. Keys start with sk-ant-.',
    canListModels: false,
  },
  openai: {
    id: 'openai',
    label: 'ChatGPT',
    wire: 'openai',
    baseUrl: 'https://api.openai.com',
    needsBaseUrl: false,
    needsKey: true,
    models: [
      {
        id: 'gpt-4o',
        label: 'GPT-4o',
        tier: 'balanced',
        inputPer1M: 2.5,
        outputPer1M: 10,
        blurb: 'OpenAI’s general-purpose model.',
      },
      {
        id: 'gpt-4o-mini',
        label: 'GPT-4o mini',
        tier: 'economy',
        inputPer1M: 0.15,
        outputPer1M: 0.6,
        blurb: 'Very cheap. Good for proofreading and quick questions.',
        utility: true,
      },
    ],
    defaultModel: 'gpt-4o',
    docsUrl: 'https://platform.openai.com/api-keys',
    pricingUrl: 'https://openai.com/api/pricing/',
    blurb: 'OpenAI’s API. Keys start with sk-. Note this is not a ChatGPT Plus subscription; the API is billed separately.',
    canListModels: false,
  },
  compatible: {
    id: 'compatible',
    label: 'OpenAI-compatible endpoint',
    wire: 'openai',
    baseUrl: '',
    needsBaseUrl: true,
    needsKey: false,
    // Empty on purpose: a self-hosted box serves whatever models it has pulled,
    // and a hard-coded list would be wrong the day Ollama adds one. Newt asks
    // the endpoint instead — see canListModels and the /models route.
    models: [],
    defaultModel: '',
    docsUrl: 'https://github.com/ollama/ollama/blob/main/docs/openai.md',
    pricingUrl: '',
    blurb: 'Ollama, OpenWebUI, LM Studio, vLLM, OpenRouter, Groq: anything serving /v1/chat/completions. Must be reachable at a public HTTPS address.',
    canListModels: true,
  },
};

export function isProviderId(v: unknown): v is ProviderId {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(PROVIDERS, v);
}

export function modelOption(provider: Provider, id: string): ModelOption | undefined {
  return provider.models.find(m => m.id === id);
}

/**
 * Whether it is safe to send `output_config.effort` for this model.
 *
 * False for anything Newt does not have in its catalogue, which covers the
 * self-hosted case and any model id typed in by hand: an endpoint that has
 * never heard of the field is as likely to reject the request as ignore it, and
 * a knob is not worth losing the answer over. See ModelOption.effort.
 */
export function supportsEffort(provider: Provider, model: string): boolean {
  return modelOption(provider, model)?.effort === true;
}

/**
 * The model to use for the cheap side tasks: proofreading, and deciding what to
 * search the feed for.
 *
 * These are mechanical jobs where the expensive model buys nothing — working
 * out that a question about "iOS 27" should search for "iOS 27" does not need
 * deep reasoning, and running it on Opus costs twenty times what it should.
 *
 * Falls back to the chosen model when the provider has no cheap tier, which is
 * the honest answer for a self-hosted endpoint: Newt does not know what else
 * that box serves, and quietly switching to a model the user did not pick would
 * be worse than paying for the one they did.
 */
export function utilityModelFor(provider: Provider, chosenModel: string): string {
  const chosen = modelOption(provider, chosenModel);
  // Already cheap: don't "downgrade" to something the user may like less.
  if (chosen?.utility) return chosenModel;
  return provider.models.find(m => m.utility)?.id ?? chosenModel;
}

/**
 * What the client is allowed to know about the providers. Identical to the
 * registry today, and a separate function anyway so that adding an
 * operator-only field later is a change in one place rather than an audit of
 * every route that serves this.
 */
export function publicProviders() {
  return Object.values(PROVIDERS).map(p => ({
    id: p.id,
    label: p.label,
    needsBaseUrl: p.needsBaseUrl,
    needsKey: p.needsKey,
    models: p.models,
    defaultModel: p.defaultModel,
    docsUrl: p.docsUrl,
    pricingUrl: p.pricingUrl,
    blurb: p.blurb,
    canListModels: p.canListModels,
  }));
}

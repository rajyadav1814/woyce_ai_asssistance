export interface ImageAttachment {
  mimeType: string;
  /** Base64 without the data: prefix. */
  data: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Images the user attached to this message (user messages only). */
  images?: ImageAttachment[];
}

export type ProviderId = 'anthropic' | 'openai' | 'gemini' | 'copilot';

export interface StreamRequest {
  /** API key; empty when signed in through an account instead. */
  apiKey: string;
  /** OAuth bearer credentials (Gemini via Google sign-in). */
  bearer?: { token: string; project?: string };
  model: string;
  maxTokens: number;
  system?: string;
  messages: ChatMessage[];
  /** Overrides the provider's default API endpoint (OpenAI-compatible servers, tests). */
  baseUrl?: string;
  signal: AbortSignal;
  onText: (delta: string) => void;
}

export interface Provider {
  readonly id: ProviderId;
  readonly label: string;
  /** 'key': needs an API key (or OAuth). 'account': uses the user's signed-in account, no key. */
  readonly auth: 'key' | 'account';
  readonly keyPlaceholder: string;
  /** Resolves with the full reply once streaming finishes. */
  stream(req: StreamRequest): Promise<string>;
}

/** Thrown when the active provider has no credentials yet; the UI offers to connect. */
export class NotConnectedError extends Error {
  constructor(
    readonly providerId: ProviderId,
    message: string,
  ) {
    super(message);
  }
}

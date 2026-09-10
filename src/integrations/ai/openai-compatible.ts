import OpenAI from 'openai';
import type { StructuredOutputProvider, StructuredOutputRequest } from './types.js';

export class AIConfigurationError extends Error {
  constructor(message = 'OPENAI_API_KEY is required to use the AI reasoning provider.') {
    super(message);
    this.name = 'AIConfigurationError';
  }
}

export interface OpenAICompatibleProviderOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  client?: OpenAIResponsesClientLike;
}

export interface OpenAIResponsesClientLike {
  responses: {
    create(request: Record<string, unknown>): Promise<{ output_text?: string; output?: unknown }>;
  };
}

const extractOutputText = (payload: unknown): string => {
  if (payload && typeof payload === 'object') {
    const response = payload as { output_text?: unknown; output?: unknown };
    if (typeof response.output_text === 'string') return response.output_text;
    if (Array.isArray(response.output)) {
      const texts: string[] = [];
      for (const item of response.output) {
        if (!item || typeof item !== 'object') continue;
        const content = (item as { content?: unknown }).content;
        if (!Array.isArray(content)) continue;
        for (const part of content) {
          if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'output_text') {
            const text = (part as { text?: unknown }).text;
            if (typeof text === 'string') texts.push(text);
          }
        }
      }
      if (texts.length) return texts.join('\n');
    }
  }
  throw new Error('AI provider returned no structured output text.');
};

export class OpenAICompatibleProvider implements StructuredOutputProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly client: OpenAIResponsesClientLike;

  constructor(options: OpenAICompatibleProviderOptions = {}) {
    const apiKey = (options.apiKey ?? process.env.OPENAI_API_KEY)?.trim();
    if (!apiKey && !options.client) throw new AIConfigurationError();
    this.apiKey = apiKey ?? 'injected-client';
    this.model = options.model ?? process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
    const baseURL = (options.baseUrl ?? process.env.OPENAI_BASE_URL)?.replace(/\/$/, '');
    this.client = options.client ?? new OpenAI({
      apiKey: this.apiKey,
      ...(baseURL ? { baseURL } : {}),
    }) as unknown as OpenAIResponsesClientLike;
  }

  async generateStructured<T>(request: StructuredOutputRequest): Promise<T> {
    const response = await this.client.responses.create({
      model: this.model,
      input: [
        { role: 'system', content: [{ type: 'input_text', text: request.systemPrompt }] },
        { role: 'user', content: [{ type: 'input_text', text: request.userPrompt }] },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: request.name,
          strict: true,
          schema: request.schema,
        },
      },
    });
    return JSON.parse(extractOutputText(response)) as T;
  }
}

export const createOpenAICompatibleProvider = (options: OpenAICompatibleProviderOptions = {}) =>
  new OpenAICompatibleProvider(options);

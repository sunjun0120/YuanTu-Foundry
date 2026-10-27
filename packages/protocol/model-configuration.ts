/** Trusted carrier-to-Host configuration. Credentials are never returned in public state or journalled. */
export interface ModelConnectionConfiguration {
  connectionId: string;
  protocol: 'anthropic' | 'openai' | 'openai-responses';
  model: string;
  baseUrl: string;
  apiKey: string;
  supportsVision?: boolean;
  maxContextTokens?: number;
  autoCompactTokens?: number;
  maxOutputTokens?: number;
  streamIdleTimeoutMs?: number;
  modelCapacities?: string;
}

export interface ModelCatalogConfiguration {
  connections: ModelConnectionConfiguration[];
  defaultConnectionId: string | null;
}

export interface ModelSelection {
  connectionId: string;
  model: string;
  protocol: string;
  supportsVision: boolean;
  configured: boolean;
}

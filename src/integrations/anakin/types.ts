export interface AnakinSdkSearchResult {
  id: string;
  results: Array<{
    url: string;
    title?: string | undefined;
    snippet?: string | undefined;
    date?: string | undefined;
    lastUpdated?: string | undefined;
  }>;
}

export interface AnakinSdkAgenticSearchResult {
  id: string;
  status: 'completed' | 'failed';
  generatedJson?: {
    summary?: string | undefined;
    structured_data?: Record<string, unknown> | undefined;
    data_schema?: Record<string, unknown> | undefined;
  } | undefined;
  error?: string | undefined;
}

export interface AnakinSdkClientLike {
  search(prompt: string, options?: { limit?: number | undefined }): Promise<AnakinSdkSearchResult>;
  agenticSearch(prompt: string, options?: { schema?: Record<string, unknown> }): Promise<AnakinSdkAgenticSearchResult>;
}

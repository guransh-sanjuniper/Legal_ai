export interface SearchResult {
  chunkId: string;
  pageStart: number;
  pageEnd: number;
  clauseFrom: string | null;
  clauses: string[];
  heading: string | null;
  windowText: string;
  fused: number;
  vectorScore: number;
  keywordScore: number;
}

export interface LawResult {
  id: string;
  title: string;
  text: string;
  fused: number;
  vectorScore: number;
  lawVersion: string;
}

export interface RetrievalEvent {
  type: string;
  [key: string]: unknown;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class RetrievalClient {
  private worker: Worker;
  private seq = 0;
  private pending = new Map<string, Pending>();

  constructor(private onEvent: (e: RetrievalEvent) => void = () => {}) {
    this.worker = new Worker(new URL('./retrieval.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<RetrievalEvent>) => {
      const data = e.data;
      const requestId = data.requestId as string | undefined;
      const terminal = ['embed-done', 'search-results', 'law-results', 'status', 'error'];
      if (requestId && this.pending.has(requestId) && terminal.includes(data.type)) {
        const p = this.pending.get(requestId)!;
        this.pending.delete(requestId);
        if (data.type === 'error') p.reject(new Error(String(data.message)));
        else p.resolve(data);
        return;
      }
      // Progress and model-loading events are not responses; they go to the listener.
      this.onEvent(data);
    };
  }

  private request<T>(msg: Record<string, unknown>): Promise<T> {
    const requestId = `r${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ ...msg, requestId });
    });
  }

  embed(docId: string): Promise<{ windows: number }> {
    return this.request<{ windows: number }>({ type: 'embed', docId });
  }

  search(docId: string, query: string, k: number): Promise<{ results: SearchResult[] }> {
    return this.request<{ results: SearchResult[] }>({ type: 'search', docId, query, k });
  }

  lawSearch(text: string, k: number): Promise<{ results: LawResult[] }> {
    return this.request<{ results: LawResult[] }>({ type: 'law-search', text, k });
  }

  status(docId: string): Promise<{ state: unknown }> {
    return this.request({ type: 'status', docId });
  }

  dispose(): void {
    this.worker.terminate();
    this.pending.clear();
  }
}

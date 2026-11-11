export interface OrderRequest {
  /** Chosen by the client and reused on every retry of the same purchase. */
  requestId: string;
  sku: string;
  quantity: number;
}

export interface Order {
  id: string;
  sku: string;
  quantity: number;
  createdAt: number;
}

export interface OrderRecord extends Order {
  requestId: string;
}

/** The storage primitive the journal writes through. */
export interface JournalFile {
  write(text: string): Promise<void>;
  /** Flush written bytes to stable storage. */
  sync(): Promise<void>;
  readAll(): Promise<string>;
}

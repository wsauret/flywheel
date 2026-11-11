import { send, type Transport } from "./http.ts";

export interface Part {
  number: number;
  etag: string;
}

/** Client for the object store's upload endpoints. */
export class StorageApi {
  constructor(
    private readonly transport: Transport,
    private readonly baseUrl: string,
  ) {}

  async putObject(name: string, body: Uint8Array): Promise<string> {
    const response = await send(this.transport, { method: "PUT", url: `${this.baseUrl}/objects/${name}`, body });
    return response.headers.etag ?? "";
  }

  async startUpload(name: string, size: number): Promise<string> {
    const response = await send(this.transport, { method: "POST", url: `${this.baseUrl}/uploads`, body: JSON.stringify({ name, size }) });
    return (JSON.parse(response.body) as { uploadId: string }).uploadId;
  }

  async putPart(uploadId: string, partNumber: number, body: Uint8Array): Promise<string> {
    const response = await send(this.transport, { method: "PUT", url: `${this.baseUrl}/uploads/${uploadId}/parts/${partNumber}`, body });
    return response.headers.etag ?? "";
  }

  async completeUpload(uploadId: string, parts: readonly Part[]): Promise<string> {
    const response = await send(this.transport, { method: "POST", url: `${this.baseUrl}/uploads/${uploadId}/complete`, body: JSON.stringify({ parts }) });
    return response.headers.etag ?? "";
  }
}

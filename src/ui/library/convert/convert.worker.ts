import { convertToPdf } from './convert';
import { loadBuiltinFont } from './fontAssets';
import { ConversionError, type WorkerRequest, type WorkerResponse } from './types';

// Module worker: the DOCX/text/image conversion runs off the main thread. It only
// produces PDF bytes; IndexedDB and the harness pipeline are not touched here.

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
};

workerScope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    const result = await convertToPdf(
      { name: request.name, type: request.type, bytes: new Uint8Array(request.bytes) },
      { fonts: loadBuiltinFont },
    );
    const bytes = result.pdf;
    const buffer =
      bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? (bytes.buffer as ArrayBuffer)
        : (bytes.slice().buffer as ArrayBuffer);
    const response: WorkerResponse = {
      id: request.id,
      ok: true,
      kind: result.kind,
      warnings: result.warnings,
      pdf: buffer,
    };
    workerScope.postMessage(response, [buffer]);
  } catch (error) {
    const response: WorkerResponse =
      error instanceof ConversionError
        ? { id: request.id, ok: false, code: error.code, message: error.message }
        : {
            id: request.id,
            ok: false,
            code: 'unreadable',
            message: 'The file could not be converted to PDF. Try saving it as a PDF and uploading that.',
          };
    workerScope.postMessage(response);
  }
};

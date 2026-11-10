import type { TaskSpec } from './types';

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function taskFingerprint(spec: Pick<TaskSpec, 'docHash' | 'prepFingerprint' | 'promptVersion' | 'prompt' | 'input'>): Promise<string> {
  return sha256Hex(JSON.stringify([spec.docHash, spec.prepFingerprint, spec.promptVersion, spec.prompt, spec.input]));
}

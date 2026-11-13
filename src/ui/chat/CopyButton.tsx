import { useEffect, useRef, useState } from 'react';
import { copyText } from '../../chat/format';

const CONFIRM_MS = 1500;

// Copies the message's stored text (Markdown as written, no citation buttons) and confirms briefly.
export function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  async function onClick() {
    const ok = await copyText(text, navigator.clipboard);
    setState(ok ? 'copied' : 'failed');
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), CONFIRM_MS);
  }

  return (
    <button type="button" className="app-chat-copy" onClick={() => void onClick()} aria-label="Copy message text">
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'}
    </button>
  );
}

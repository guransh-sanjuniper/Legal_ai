import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal } from './Modal';
import { leaveMessage, shouldBlockNav, type LeaveJob } from './leaveGuard';

// While a long job is running, stop an in-app link, a guarded navigate call or the
// browser's Back button and ask the user to stay. The browser supplies its own text
// for close/reload. "Leave anyway" performs the same navigation as before; nothing is
// cancelled here. A history sentinel makes Back land on the same URL so the page is
// not torn down before the pop-up appears.

interface PendingHref {
  kind: 'href';
  href: string;
}

interface PendingBack {
  kind: 'back';
}

type Pending = PendingHref | PendingBack;

const SENTINEL_KEY = '__legalAppLeaveGuard';

function sentinelState(previous: unknown): Record<string, unknown> {
  return {
    ...(previous && typeof previous === 'object' ? (previous as Record<string, unknown>) : {}),
    [SENTINEL_KEY]: true,
  };
}

function isSentinel(state: unknown): boolean {
  return Boolean(
    state &&
      typeof state === 'object' &&
      (state as Record<string, unknown>)[SENTINEL_KEY] === true,
  );
}

function routerHref(anchor: HTMLAnchorElement): string {
  const url = new URL(anchor.href);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function useLeaveGuard({ active, job }: { active: boolean; job: LeaveJob }): {
  navigate: (to: string) => void;
  dialog: ReactNode;
} {
  const navigate = useNavigate();
  const activeRef = useRef(active);
  activeRef.current = active;
  const allowRef = useRef(false);
  const guardedUrlRef = useRef<string | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const afterBackRef = useRef<string | null>(null);
  const sentinelRef = useRef(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!active) {
      // A finished job must not leave a duplicate history entry behind.
      if (sentinelRef.current && isSentinel(window.history.state)) {
        sentinelRef.current = false;
        window.history.back();
      }
      guardedUrlRef.current = null;
      pendingRef.current = null;
      afterBackRef.current = null;
      allowRef.current = false;
      setOpen(false);
      return;
    }

    const guardedUrl = window.location.href;
    guardedUrlRef.current = guardedUrl;
    if (!sentinelRef.current && !isSentinel(window.history.state)) {
      sentinelRef.current = true;
      window.history.pushState(sentinelState(window.history.state), '', guardedUrl);
    }

    const onClick = (event: MouseEvent) => {
      if (!activeRef.current || event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor =
        event.target instanceof Element ? (event.target.closest('a[href]') as HTMLAnchorElement | null) : null;
      if (!anchor) return;
      const href = anchor.getAttribute('href') ?? '';
      if (
        !shouldBlockNav({
          active: true,
          href,
          currentHref: window.location.href,
          target: anchor.getAttribute('target'),
          download: anchor.hasAttribute('download'),
          modifier: false,
        })
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      pendingRef.current = { kind: 'href', href: routerHref(anchor) };
      setOpen(true);
    };

    const onPopState = () => {
      if (!activeRef.current) return;
      if (allowRef.current) {
        const target = afterBackRef.current;
        afterBackRef.current = null;
        if (target) navigate(target);
        return;
      }
      if (!guardedUrlRef.current || window.location.href !== guardedUrlRef.current) return;
      // Back from the sentinel lands on the page's own duplicate entry. Re-arm it and ask.
      window.history.pushState(sentinelState(window.history.state), '', guardedUrlRef.current);
      pendingRef.current = { kind: 'back' };
      setOpen(true);
    };

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!activeRef.current || allowRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };

    document.addEventListener('click', onClick, true);
    window.addEventListener('popstate', onPopState);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
    // `navigate` is stable for the router's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, navigate]);

  function guardedNavigate(to: string) {
    if (
      !activeRef.current ||
      !shouldBlockNav({
        active: true,
        href: to,
        currentHref: window.location.href,
        modifier: false,
      })
    ) {
      navigate(to);
      return;
    }
    pendingRef.current = { kind: 'href', href: to };
    setOpen(true);
  }

  function stay() {
    pendingRef.current = null;
    setOpen(false);
  }

  function leave() {
    const pending = pendingRef.current;
    pendingRef.current = null;
    setOpen(false);
    if (!pending) return;
    allowRef.current = true;
    sentinelRef.current = false;
    if (pending.kind === 'back') {
      // We are on the sentinel: step past it and the page's original entry.
      window.history.go(-2);
      return;
    }
    if (isSentinel(window.history.state)) {
      // Remove the sentinel first so the destination is not followed by a duplicate.
      afterBackRef.current = pending.href;
      window.history.back();
      return;
    }
    navigate(pending.href);
  }

  const dialog = open ? (
    <Modal labelledBy="leave-guard-title" onClose={stay}>
      <h2 id="leave-guard-title">Please stay on this page</h2>
      <p className="app-leave-text">{leaveMessage(job)}</p>
      <div className="app-modal-actions app-leave-actions">
        <button type="button" className="app-primary-button app-leave-button" onClick={stay}>
          Stay on this page
        </button>
        <button type="button" className="app-modal-secondary app-leave-button" onClick={leave}>
          Leave anyway
        </button>
      </div>
    </Modal>
  ) : null;

  return { navigate: guardedNavigate, dialog };
}

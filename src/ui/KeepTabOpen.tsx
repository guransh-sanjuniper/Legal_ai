// Shared on-screen reminder for long jobs that run in this browser tab.
export function KeepTabOpen({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <p className="app-keep-tab-open">Keep this tab open until this finishes. You can use other tabs or apps.</p>
  );
}

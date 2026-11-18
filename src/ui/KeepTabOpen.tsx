// Shared on-screen reminder for long jobs that run in this browser tab.
export function KeepTabOpen({ show, prominent }: { show: boolean; prominent?: boolean }) {
  if (!show) return null;
  return (
    <p className={`app-keep-tab-open${prominent ? ' app-keep-tab-open--prominent' : ''}`}>
      Keep this tab open until this finishes. You may use other tabs or programs.
    </p>
  );
}

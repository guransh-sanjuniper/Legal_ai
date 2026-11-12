import { PageHeader } from './Placeholder';

export function ChatPage() {
  return (
    <div className="app-chat-page">
      <PageHeader
        eyebrow="Module"
        title="Chat"
        description="Ask about a document or a point of law. Answers will cite the page and clause, and say when something is not found."
      />
      <div className="app-chat-empty">
        <h2>What would you like to review?</h2>
        <p className="app-muted">
          Chat will use the existing local retrieval, verified quotes and whole-document passes. It is the next module to be
          wired up.
        </p>
      </div>
      <div className="app-composer app-composer--disabled" aria-disabled="true">
        <input disabled placeholder="Chat is coming next" aria-label="Chat message" />
        <button type="button" className="app-primary-button" disabled>
          Send
        </button>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import type { ChatTurn, Source } from '../lib/gemini-shared';

export interface ChatReply {
  text: string;
  sources?: Source[];
  /** Quick replies shown as chips under this answer. */
  suggestions?: string[];
}

interface Message extends ChatTurn {
  sources?: Source[];
  suggestions?: string[];
  error?: boolean;
}

interface Props {
  id: string;
  title: string;
  greeting: string;
  placeholder: string;
  /** Receives the question and the earlier turns (oldest first). */
  onAsk: (question: string, history: ChatTurn[]) => Promise<ChatReply>;
  variant?: 'dataset' | 'guide';
  /** Quick replies shown under the greeting before the first message. */
  starters?: string[];
}

const markdownComponents = {
  a: ({ href, children }: { href?: string; children?: ReactNode }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
};

export default function ChatPanel({ id, title, greeting, placeholder, onAsk, variant = 'dataset', starters = [] }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, thinking]);

  const ask = async (text: string) => {
    const question = text.trim();
    if (!question || thinking) return;
    const history: ChatTurn[] = messages.filter(m => !m.error).map(m => ({ role: m.role, text: m.text }));
    setMessages(m => [...m, { role: 'user', text: question }]);
    setInput('');
    setThinking(true);
    try {
      const reply = await onAsk(question, history);
      setMessages(m => [...m, { role: 'model', text: reply.text || 'No answer was returned.', sources: reply.sources, suggestions: reply.suggestions }]);
    } catch (err) {
      setMessages(m => [...m, { role: 'model', text: err instanceof Error ? err.message : 'The assistant could not answer.', error: true }]);
    } finally {
      setThinking(false);
    }
  };

  const send = (e: FormEvent) => {
    e.preventDefault();
    ask(input);
  };

  const last = messages[messages.length - 1];
  const chips = thinking ? [] : messages.length === 0 ? starters : last?.role === 'model' ? (last.suggestions ?? []) : [];

  return (
    <section className={`chat-panel chat-${variant}`} aria-label={title}>
      <div className="chat-header">
        <span className="pulse-dot" aria-hidden="true" /> {title}
      </div>
      <div className="chat-history" ref={scrollRef} aria-live="polite">
        <div className="chat-bubble bot-style">
          <span className="sender-label">TerraX</span>
          <div className="chat-text">{greeting}</div>
        </div>
        {messages.map((m, i) => (
          <div key={i} className={`chat-bubble ${m.role === 'model' ? 'bot-style' : 'user-style'} ${m.error ? 'error-style' : ''}`}>
            <span className="sender-label">{m.role === 'model' ? 'TerraX' : 'You'}</span>
            <div className="chat-text markdown">
              <ReactMarkdown components={markdownComponents}>{m.text}</ReactMarkdown>
            </div>
            {m.sources && m.sources.length > 0 && (
              <ol className="source-list">
                {m.sources.map(s => (
                  <li key={s.uri}>
                    <a href={s.uri} target="_blank" rel="noopener noreferrer">
                      {s.title}
                    </a>
                  </li>
                ))}
              </ol>
            )}
          </div>
        ))}
        {thinking && <div className="chat-bubble bot-style typing">Thinking…</div>}
        {chips.length > 0 && (
          <div className="chat-chips" aria-label="Suggested questions">
            {chips.map(c => (
              <button key={c} type="button" className="chat-chip" onClick={() => ask(c)}>
                {c}
              </button>
            ))}
          </div>
        )}
      </div>
      <form className="chat-input-area" onSubmit={send}>
        <label htmlFor={`${id}-input`} className="visually-hidden">
          {placeholder}
        </label>
        <input id={`${id}-input`} type="text" value={input} onChange={e => setInput(e.target.value)} placeholder={placeholder} disabled={thinking} autoComplete="off" />
        <button type="submit" disabled={thinking || !input.trim()}>
          Send
        </button>
      </form>
    </section>
  );
}

import React, { useState, useEffect, useRef } from 'react';

interface ChatMessage {
  sender: 'bot' | 'user';
  text: string;
}

interface SystemGuideBotProps {
  onSendMessage: (msg: string) => Promise<string>;
}

const SystemGuideBot: React.FC<SystemGuideBotProps> = ({ onSendMessage }) => {
  const [messages, setMessages] = useState<ChatMessage[]>([
    { sender: 'bot', text: 'TERRASENSE OS v1.0 ONLINE. I am the system guide. How can I assist your mission today?' }
  ]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isTyping]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isTyping) return;

    const userMsg = input.trim();
    setMessages(prev => [...prev, { sender: 'user', text: userMsg }]);
    setInput('');
    setIsTyping(true);

    try {
      const botResponse = await onSendMessage(userMsg);
      setMessages(prev => [...prev, { sender: 'bot', text: botResponse }]);
    } catch (err) {
      setMessages(prev => [...prev, { sender: 'bot', text: "OS ALERT: Neural connection drop. Please check uplink." }]);
    } finally {
      setIsTyping(false);
    }
  };

  return (
    <div className="system-guide-bot">
      <div className="system-header">
        <span className="system-pulse"></span> OS GUIDE // TERRASENSE NET
      </div>
      
      <div className="system-history">
        {messages.map((msg, idx) => (
          <div key={idx} className={`sys-bubble ${msg.sender === 'bot' ? 'sys-bot' : 'sys-user'}`}>
            <span className="sys-label">{msg.sender === 'bot' ? 'OS:' : 'OP:'}</span>
            <span style={{ whiteSpace: 'pre-wrap' }}>{msg.text}</span>
          </div>
        ))}
        {isTyping && (
           <div className="sys-bubble sys-bot animate-pulse">
             <span className="sys-label">OS:</span>
             <span>[ UPLINKING TO NEURAL CORE... ]</span>
           </div>
        )}
        <div ref={chatEndRef} />
      </div>

      <form className="sys-input-area" onSubmit={handleSend}>
        <span className="sys-cursor">&gt;</span>
        <input 
          type="text" 
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={isTyping ? "OS Thinking..." : "Ask about TerraSense..."}
          disabled={isTyping}
        />
        <button type="submit" disabled={isTyping}>[EXECUTE]</button>
      </form>
    </div>
  );
};

export default SystemGuideBot;

import React, { useState, useEffect, useRef } from 'react';

interface ChatMessage {
  sender: 'bot' | 'user';
  text: string;
}

interface LocalChatbotProps {
  currentReport: any;
  onSendMessage: (msg: string) => Promise<string>;
}

const LocalChatbot: React.FC<LocalChatbotProps> = ({ currentReport, onSendMessage }) => {
  const [messages, setMessages] = useState<ChatMessage[]>([
    { sender: 'bot', text: 'TERRASENSE INTELLIGENCE INITIALIZED. CONNECTED TO SATELLITE CORE.' }
  ]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Auto-announce when a new file is uploaded
  useEffect(() => {
    if (currentReport) {
      setMessages(prev => [...prev, { 
        sender: 'bot', 
        text: `CORE SYNC: Dataset [${currentReport.filename}] loaded into local memory. Intelligent reasoning active. How can I assist with your geospatial analysis?` 
      }]);
    } else {
      setMessages([{ sender: 'bot', text: 'TERRASENSE NEURAL LINK READY. AWAITING DATA UPLOAD.' }]);
    }
  }, [currentReport]);

  // Auto-scroll to the bottom of the chat
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
      setMessages(prev => [...prev, { sender: 'bot', text: "LINK ERROR: Remote neural processor unavailable. Local heuristics failed." }]);
    } finally {
      setIsTyping(false);
    }
  };

  return (
    <div className="local-chatbot">
      <div className="chatbot-header">
        <span className="pulse-dot"></span> TERRASENSE // MULTISPECTRAL AI
      </div>
      
      <div className="chat-history">
        {messages.map((msg, idx) => (
          <div key={idx} className={`chat-bubble ${msg.sender === 'bot' ? 'bot-style' : 'user-style'}`}>
            <span className="sender-label">{msg.sender === 'bot' ? 'SYS:' : 'OP:'}</span>
            <span style={{ whiteSpace: 'pre-wrap' }}>{msg.text}</span>
          </div>
        ))}
        {isTyping && (
          <div className="chat-bubble bot-style typing-indicator text-xs animate-pulse">
            [ PROCESSING NEURAL RESPONSE... ]
          </div>
        )}
        <div ref={chatEndRef} />
      </div>

      <form className="chat-input-area" onSubmit={handleSend}>
        <span className="cursor-prompt">&gt;</span>
        <input 
          type="text" 
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={isTyping ? "AI thinking..." : "Query satellite data..."}
          disabled={isTyping}
        />
        <button type="submit" disabled={isTyping}>[SEND]</button>
      </form>
    </div>
  );
};


export default LocalChatbot;

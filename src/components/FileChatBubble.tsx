import React, { useState } from 'react';

interface FileChatBubbleProps {
  message: string;
  sender: 'user' | 'bot';
}

const FileChatBubble: React.FC<FileChatBubbleProps> = ({ message, sender }) => {
  const [isExpanded, setIsExpanded] = useState(false);

  // LOGIC: Check if this is a long file dump
  const isLongFile = message.length > 250;

  // Function to create a "Normal" 3-sentence summary for the UI
  const getSummary = (text: string) => {
    // In a real app, an AI does this. For the hackathon, we slice it 
    // and add a professional telemetry-style prefix.
    return text.substring(0, 200) + "... [TELEMETRY DATA CONDENSED]";
  };

  return (
    <div className={`chat-bubble ${sender === 'bot' ? 'bot-style' : 'user-style'}`}>
      <div className="bubble-header">
        {sender === 'bot' ? 'TERRASENSE AI' : 'OPERATOR'}
      </div>

      <div className="bubble-content">
        {isLongFile && !isExpanded ? (
          <>
            <p className="summary-text">
              <strong>REPORT SUMMARY:</strong> {getSummary(message)}
            </p>
            <button 
              className="view-raw-btn" 
              onClick={() => setIsExpanded(true)}
            >
              VIEW RAW DATA SOURCE [↓]
            </button>
          </>
        ) : (
          <p className="normal-text">{message}</p>
        )}

        {isExpanded && (
          <div className="raw-data-dump">
            <pre>{message}</pre>
            <button 
              className="view-raw-btn" 
              onClick={() => setIsExpanded(false)}
            >
              HIDE RAW DATA [↑]
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default FileChatBubble;

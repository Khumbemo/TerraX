import React, { useState } from 'react';

interface StandardLoginProps {
  onLoginSuccess: () => void;
}

const StandardLogin: React.FC<StandardLoginProps> = ({ onLoginSuccess }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [loadingText, setLoadingText] = useState('');

  // Handles the standard Email/Password flow
  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!agreedToTerms) {
      alert("You must agree to the Terms of Service to create a secure session.");
      return;
    }
    triggerAuthSequence('VERIFYING CREDENTIALS...');
  };

  // Handles the Guest bypass
  const handleGuestLogin = () => {
    triggerAuthSequence('ALLOCATING GUEST INSTANCE...');
  };

  // The cinematic transition to the dashboard
  const triggerAuthSequence = (initialText: string) => {
    setIsAuthenticating(true);
    setLoadingText(initialText);

    setTimeout(() => setLoadingText('ESTABLISHING ORBITAL LINK...'), 800);
    setTimeout(() => setLoadingText('ACCESS GRANTED. ROUTING...'), 1600);
    
    setTimeout(() => {
      onLoginSuccess();
    }, 2200);
  };

  return (
    <div className="login-wrapper">
      <div className="login-panel">
        
        <div className="login-header">
          <div className="brand-title">TERRASENSE</div>
          <div className="brand-subtitle">ORBITAL INTELLIGENCE NETWORK</div>
        </div>

        {!isAuthenticating ? (
          <form onSubmit={handleLogin} className="login-form">
            
            <div className="input-group">
              <label>EMAIL IDENTIFICATION</label>
              <input 
                type="email" 
                placeholder="researcher@institute.edu" 
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required 
              />
            </div>
            
            <div className="input-group">
              <label>SECURE PASSWORD</label>
              <input 
                type="password" 
                placeholder="••••••••" 
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required 
              />
            </div>

            {/* Terms Checkbox */}
            <div className="terms-group">
              <label className="checkbox-container">
                <input 
                  type="checkbox" 
                  checked={agreedToTerms}
                  onChange={(e) => setAgreedToTerms(e.target.checked)}
                />
                <span className="checkmark"></span>
                <span className="terms-text">
                  I agree to the <a href="#terms">Terms of Service</a> & <a href="#privacy">Data Policy</a>
                </span>
              </label>
            </div>

            <button 
              type="submit" 
              className={`uplink-btn ${!agreedToTerms ? 'disabled' : ''}`}
            >
              AUTHENTICATE SESSION
            </button>

            <div className="divider">
              <span>OR</span>
            </div>

            {/* Guest Login Button */}
            <button 
              type="button" 
              className="guest-btn"
              onClick={handleGuestLogin}
            >
              CONTINUE AS GUEST
            </button>

          </form>
        ) : (
          <div className="terminal-sequence">
            <div className="loader-spinner"></div>
            <div className="terminal-line final-grant">
              {loadingText}
            </div>
          </div>
        )}

      </div>
    </div>
  );
};

export default StandardLogin;

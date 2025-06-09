import React from 'react';
import { AuthProvider } from './components/AuthContext';
import InboxManager from './components/InboxManager';

function App() {
  return (
    <AuthProvider>
      <InboxManager />
    </AuthProvider>
  );
}

export default App;

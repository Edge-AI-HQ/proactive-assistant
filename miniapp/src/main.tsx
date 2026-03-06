import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// Load eruda for debugging in development/staging
if (import.meta.env.DEV || window.location.hostname.includes('-dev.fly.dev')) {
  import('eruda').then((eruda) => {
    eruda.default.init();
    console.log('[Debug] Eruda console initialized');
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

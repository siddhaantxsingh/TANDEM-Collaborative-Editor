import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<App />);

// Offline application shell (see public/sw.js). Production builds only, so
// that the development server is never served stale code.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/sw.js").catch((err) => console.warn("service worker registration failed", err));
}

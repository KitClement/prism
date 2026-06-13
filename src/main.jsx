import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./theme.css";

// Apply the saved theme before first paint so there's no flash of the wrong palette.
try {
  const t = localStorage.getItem("prism-theme");
  document.documentElement.dataset.theme = t === "dark" ? "dark" : "light";
} catch { document.documentElement.dataset.theme = "light"; }

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

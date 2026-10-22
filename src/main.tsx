import "./style.css";
import React from "react";
import { createRoot } from "react-dom/client";
import { StudioShell } from "./StudioShell";
import { App } from "./App";
import "./studio.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {new URLSearchParams(location.search).get("workspace") === "partsmith" ? (
      <App />
    ) : (
      <StudioShell />
    )}
  </React.StrictMode>,
);

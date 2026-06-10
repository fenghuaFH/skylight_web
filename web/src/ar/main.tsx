import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ARDisplay } from "./ARDisplay.js";
import "../styles/ar.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ARDisplay />
  </StrictMode>,
);

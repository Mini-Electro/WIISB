import React from "react";
import ReactDOM from "react-dom/client";
import "@/styles/index.css";
import { App } from "@/app/App";
import { UpdateBar } from "@/components/UpdateBar";

// Native-feeling desktop app: no browser context menu.
window.addEventListener("contextmenu", (e) => {
  if (!(e.target as HTMLElement)?.closest?.("input, textarea")) e.preventDefault();
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
    <UpdateBar />
  </React.StrictMode>,
);

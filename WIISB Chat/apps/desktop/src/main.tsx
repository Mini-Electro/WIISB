import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "./styles.css";
import { App } from "./App";
import { AppContextMenu } from "./components/AppContextMenu";
import { UpdateBar } from "./components/UpdateBar";
class Boundary extends React.Component<
  { children: React.ReactNode },
  { error: boolean }
> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  render() {
    return this.state.error ? (
      <main className="empty">
        <h1>WIISB Chat hit a problem.</h1>
        <p>Your messages are stored on the server.</p>
        <button className="primary" onClick={() => location.reload()}>
          Reopen Chat
        </button>
      </main>
    ) : (
      this.props.children
    );
  }
}
createRoot(document.getElementById("root")!).render(
  <Boundary>
    <App />
    <AppContextMenu />
    <UpdateBar />
  </Boundary>,
);

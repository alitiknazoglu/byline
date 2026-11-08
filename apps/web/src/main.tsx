import "@fontsource-variable/jetbrains-mono";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Terminal } from "./term";
import { WalletProvider } from "./wallet";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WalletProvider>
      <Terminal />
    </WalletProvider>
  </StrictMode>,
);

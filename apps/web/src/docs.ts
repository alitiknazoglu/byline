/**
 * The /docs page is static HTML (readable by search engines and agents). This gives it the terminal's
 * look: the same stylesheet and header as the terminal, plus the network this domain serves in the
 * prompt and the status bar.
 */
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";
import "./docs.css";
import { IS_MAINNET, NETWORK, OTHER_NETWORK, OTHER_SITE, REGISTRY, registryUp } from "./network";

const set = (selector: string, fn: (el: HTMLElement) => void) => document.querySelectorAll<HTMLElement>(selector).forEach(fn);

set("[data-net]", (el) => (el.textContent = NETWORK));
set("[data-net-label]", (el) => (el.textContent = `NEAR ${NETWORK}`));
set("[data-other-site]", (el) => {
  el.textContent = `${OTHER_NETWORK} ↗`;
  el.setAttribute("href", OTHER_SITE);
});
set("[data-registry]", (el) => {
  el.textContent = `registry ${REGISTRY}${IS_MAINNET ? " ✓ verified" : ""}`;
  el.setAttribute("href", `${IS_MAINNET ? "https://nearblocks.io" : "https://testnet.nearblocks.io"}/address/${REGISTRY}?tab=contract`);
});

// The status dot, as in the terminal: green while the registry answers over RPC, red when it doesn't.
const health = () =>
  void registryUp().then((up) =>
    set("[data-health]", (el) => {
      const label = up ? `operational: ${REGISTRY} is answering` : `down: can't reach ${REGISTRY} right now`;
      el.className = `dot ${up ? "up" : "down"}`;
      el.title = label;
      el.setAttribute("aria-label", label);
    }),
  );
health();
window.setInterval(health, 60_000);

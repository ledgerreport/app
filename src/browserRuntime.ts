import { esploraBaseFrom, type Runtime } from "./core/runtime";

// Browser host for the shared report logic: Vite build-time env and
// localStorage. Only the React app imports this module — the headless CLI has
// its own runtime, so no import.meta.env value is ever baked into the CLI
// bundle.
const apiKey: string | undefined = import.meta.env.VITE_ALCHEMY_API_KEY;
const ALCHEMY_KEY_PLACEHOLDER = "your_alchemy_api_key_here";

export const browserRuntime: Runtime = {
  // Only called when an EVM request is made, so the page and Bitcoin reports
  // work without a key; an EVM lookup then shows this message in the form.
  getAlchemyApiKey: () => {
    if (!apiKey || apiKey === ALCHEMY_KEY_PLACEHOLDER) {
      throw new Error(
        "EVM balances are unavailable: no Alchemy API key (VITE_ALCHEMY_API_KEY) is configured for this site.",
      );
    }
    return apiKey;
  },
  esploraBase: esploraBaseFrom(import.meta.env.VITE_ESPLORA_URL),
  cache: {
    get: (key) => localStorage.getItem(key),
    set: (key, value) => localStorage.setItem(key, value),
  },
  fetchCoinGecko: (url) => fetch(url),
  log: (message) => console.info(message),
};

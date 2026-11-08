import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

/** In dev, serve /docs like Vercel does in production (cleanUrls maps /docs to docs.html). */
const cleanDocsUrl: Plugin = {
  name: "byline-clean-docs-url",
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url === "/docs" || req.url?.startsWith("/docs?") || req.url?.startsWith("/docs#")) req.url = "/docs.html";
      next();
    });
  },
};

const page = (f: string) => fileURLToPath(new URL(f, import.meta.url));

export default defineConfig({
  plugins: [react(), cleanDocsUrl],
  build: {
    target: "es2022",
    sourcemap: true,
    // Two HTML pages: the terminal (index.html) and the static docs page (docs.html).
    rollupOptions: { input: { main: page("index.html"), docs: page("docs.html") } },
  },
  server: { port: 5173 },
});

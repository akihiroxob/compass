import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  cacheDir: fileURLToPath(new URL("../../node_modules/.vite", import.meta.url)),
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:51743",
      "/health": "http://localhost:51743",
      "/mcp": "http://localhost:51743"
    }
  },
  build: {
    outDir: "../../public",
    emptyOutDir: true
  }
});

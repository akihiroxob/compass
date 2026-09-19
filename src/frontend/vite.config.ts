import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const target = `http://localhost:${Number(process.env.PORT) || 51800}`;

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  cacheDir: fileURLToPath(new URL("../../node_modules/.vite", import.meta.url)),
  plugins: [react()],
  server: {
    proxy: {
      "/api": target,
      "/health": target,
      "/mcp": target
    }
  },
  build: {
    outDir: "../../public",
    emptyOutDir: true
  }
});

import { defineConfig } from "vite";

// Root is passed via CLI (`vite build client` / `vite client`), so no `root` here.
export default defineConfig({
  base: "/",
  build: {
    outDir: "../dist-client",
    emptyOutDir: true,
    target: "es2022",
  },
  server: {
    port: 5173,
    proxy: { "/ws": { target: "http://localhost:6000", ws: true } },
  },
});

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const target = process.env.TANDEM_SERVER ?? "http://127.0.0.1:8080";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": { target, changeOrigin: false },
      "/ws": { target: target.replace("http", "ws"), ws: true },
    },
  },
  build: { outDir: "dist", sourcemap: true, chunkSizeWarningLimit: 4000 },
});

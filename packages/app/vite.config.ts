import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

// `vite dev` sends /api to the running office's TCP listener; add http://localhost:5173 to "dev_origins" in
// office/hq.json once, then restart the office.
const office = `http://127.0.0.1:${process.env.OPENCORP_HQ_PORT ?? 49380}`

export default defineConfig({
  plugins: [solid(), tailwindcss()],
  server: { port: 5173, strictPort: true, proxy: { "/api": { target: office, changeOrigin: true } } },
  // No inline module-preload polyfill: the CSP allows only same-origin script files.
  build: { target: "esnext", modulePreload: { polyfill: false } },
})

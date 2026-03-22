import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],

  // Vite options tailored for Tauri development.
  // Prevents Vite from clearing the terminal output on startup.
  clearScreen: false,

  server: {
    // Tauri expects a fixed port; fail if it's not available.
    port: 1420,
    strictPort: true,
    watch: {
      // Tell Vite to ignore watching `src-tauri` to avoid unnecessary rebuilds.
      ignored: ["**/src-tauri/**"],
    },
  },
});

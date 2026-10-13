import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset URLs, so the build works from any path, e.g. the GitHub
  // Pages project site at https://safouane100.github.io/hifdh/.
  base: "./",
  server: {
    allowedHosts: ["laptop-mac", "laptop-mac.tail.safnine.pw"],
  },
});

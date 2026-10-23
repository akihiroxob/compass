import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
  stories: ["../src/web/**/*.stories.tsx"],
  framework: "@storybook/react-vite",
  addons: ["@storybook/addon-docs"],
  core: { disableTelemetry: true },
  // 製品のAPI proxy・public成果物・環境変数をカタログへ持ち込まない。
  viteFinal: (config) => ({ ...config, publicDir: false, esbuild: { jsx: "automatic" }, envPrefix: "CATALOG_PUBLIC_" }),
};
export default config;

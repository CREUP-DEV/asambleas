// @ts-check
import withNuxt from "./.nuxt/eslint.config.mjs";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";

// .sim77 is local scratch (git-excluded): never block pnpm verify.
export default withNuxt([
  { ignores: [".sim77/"] },
  eslintPluginPrettierRecommended,
]);

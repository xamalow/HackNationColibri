// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    settings: {
      // Resolve the Domain and Experience workspace aliases declared in tsconfig.json.
      'import/resolver': {
        node: { extensions: ['.js', '.jsx', '.ts', '.tsx'] },
        typescript: { project: './tsconfig.json' },
      },
    },
  },
  {
    ignores: ["dist/*"],
  }
]);

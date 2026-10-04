// Metro must see the workspace packages the app consumes without a root (hoisted) install:
// @sauti/core (Domain core, built to packages/core/dist by `npm run build:core`) and the
// Experience copy (packages/experience). Their own deps resolve from this app's node_modules.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const repoRoot = path.resolve(__dirname, '../..');
const config = getDefaultConfig(__dirname);

config.watchFolders = [
  path.join(repoRoot, 'packages/core'),
  path.join(repoRoot, 'packages/experience'),
];
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules ?? {}),
  '@sauti/core': path.join(repoRoot, 'packages/core'),
  '@sauti/experience': path.join(repoRoot, 'packages/experience'),
};
config.resolver.nodeModulesPaths = [path.join(__dirname, 'node_modules')];

module.exports = config;

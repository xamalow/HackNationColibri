// Dynamic Expo config: app.json unchanged, plus one opt-in switch for signing with a free Apple account.
//
// SAUTI_PERSONAL_TEAM=1 builds for an Xcode Personal Team, which cannot sign the increased-memory-limit or
// extended-virtual-addressing entitlements and cannot reuse a bundle id registered by another team. It removes both
// entitlements (from app.json and from the llama.rn plugin, which adds them again for a production profile) and
// signs as SAUTI_BUNDLE_ID, default com.sautihost.mobile.personal. Without the memory entitlement the app gets the
// standard iOS memory limit, which is why the phone default is Gemma 4 E2B (apps/mobile/src/models/gemma.ts).
const MEMORY_ENTITLEMENTS = [
  'com.apple.developer.kernel.increased-memory-limit',
  'com.apple.developer.kernel.extended-virtual-addressing',
];

module.exports = ({ config }) => {
  if (process.env.SAUTI_PERSONAL_TEAM !== '1') return config;
  const entitlements = { ...(config.ios?.entitlements ?? {}) };
  for (const key of MEMORY_ENTITLEMENTS) delete entitlements[key];
  const plugins = (config.plugins ?? []).map((plugin) =>
    Array.isArray(plugin) && plugin[0] === 'llama.rn' ? ['llama.rn', { ...plugin[1], enableEntitlements: false }] : plugin,
  );
  return {
    ...config,
    ios: {
      ...config.ios,
      bundleIdentifier: process.env.SAUTI_BUNDLE_ID || `${config.ios.bundleIdentifier}.personal`,
      entitlements,
    },
    plugins,
  };
};

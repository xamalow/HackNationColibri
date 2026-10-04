const fs = require('node:fs');
const path = require('node:path');
const { createRunOncePlugin, withDangerousMod } = require('@expo/config-plugins');

const ORT_VERSION = '1.24.3';

function replacePinnedMavenVersions(source) {
  const updated = source.replace(
    /(com\.microsoft\.onnxruntime:onnxruntime-(?:android(?:-qnn)?|extensions-android):)(?:latest\.integration|1\.24\.3)(@aar)/g,
    `$1${ORT_VERSION}$2`,
  );
  if (updated === source && /com\.microsoft\.onnxruntime:onnxruntime-(?:android(?:-qnn)?|extensions-android):latest\.integration/.test(source)) {
    throw new Error('onnxruntime-react-native: could not pin its Android ONNX Runtime Maven artifacts.');
  }
  return updated;
}

function patchAndroid(packageRoot) {
  const gradlePath = path.join(packageRoot, 'android', 'build.gradle');
  let source = fs.readFileSync(gradlePath, 'utf8');
  source = replacePinnedMavenVersions(source);
  const versionNumberCheck = /if\s*\(\s*VersionNumber\.parse\(REACT_NATIVE_VERSION\)\s*<\s*VersionNumber\.parse\("0\.71"\)\s*\)/;
  if (versionNumberCheck.test(source)) source = source.replace(versionNumberCheck, 'if (REACT_NATIVE_MINOR_VERSION < 71)');
  else if (source.includes('VersionNumber.parse')) throw new Error('onnxruntime-react-native: unexpected Gradle VersionNumber check; review this package version before building.');
  fs.writeFileSync(gradlePath, source);

  // Expo SDK 57's autolinker treats this legacy metadata as an Expo module manifest,
  // which can suppress the package's React Native Android autolinking entry.
  const legacyManifest = path.join(packageRoot, 'unimodule.json');
  if (fs.existsSync(legacyManifest)) fs.rmSync(legacyManifest);
}

function patchIos(packageRoot) {
  const podspecPath = path.join(packageRoot, 'onnxruntime-react-native.podspec');
  let source = fs.readFileSync(podspecPath, 'utf8');
  const dependency = /spec\.dependency\s+"onnxruntime-c"(?:,\s*"[^"]+")?/;
  if (dependency.test(source)) source = source.replace(dependency, `spec.dependency "onnxruntime-c", "${ORT_VERSION}"`);
  else if (!source.includes(`spec.dependency "onnxruntime-c", "${ORT_VERSION}"`)) {
    throw new Error('onnxruntime-react-native: could not pin its iOS ONNX Runtime pod.');
  }
  fs.writeFileSync(podspecPath, source);
}

function packageRoot(projectRoot) {
  const root = path.join(projectRoot, 'node_modules', 'onnxruntime-react-native');
  if (!fs.existsSync(path.join(root, 'package.json'))) {
    throw new Error('Install the pinned onnxruntime-react-native package before running Expo prebuild.');
  }
  return root;
}

function withOnnxRuntimeCompatibility(config) {
  config = withDangerousMod(config, [
    'android',
    async (modConfig) => {
      patchAndroid(packageRoot(modConfig.modRequest.projectRoot));
      return modConfig;
    },
  ]);
  config = withDangerousMod(config, [
    'ios',
    async (modConfig) => {
      patchIos(packageRoot(modConfig.modRequest.projectRoot));
      return modConfig;
    },
  ]);
  return config;
}

const plugin = createRunOncePlugin(withOnnxRuntimeCompatibility, 'with-sauti-onnx-runtime-compatibility', '1.0.0');
module.exports = Object.assign(plugin, { patchAndroid, patchIos });

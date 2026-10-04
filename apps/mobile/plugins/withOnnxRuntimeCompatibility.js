const fs = require('node:fs');
const path = require('node:path');
const { createRunOncePlugin, withAppBuildGradle, withDangerousMod } = require('@expo/config-plugins');
const generateCode = require('@expo/config-plugins/build/utils/generateCode');

const ORT_VERSION = '1.24.3';

function replacePinnedMavenVersions(source) {
  let runtimeArtifacts = 0;
  const updated = source.replace(
    /(com\.microsoft\.onnxruntime:onnxruntime-(?:android(?:-qnn)?):)[^@"'\s]+(@aar)/g,
    (_match, prefix, suffix) => {
      runtimeArtifacts += 1;
      return `${prefix}${ORT_VERSION}${suffix}`;
    },
  );
  if (runtimeArtifacts === 0) {
    throw new Error('onnxruntime-react-native: could not pin its Android ONNX Runtime Maven artifacts.');
  }
  return updated;
}

function patchAndroid(packageRoot) {
  const gradlePath = path.join(packageRoot, 'android', 'build.gradle');
  let source = fs.readFileSync(gradlePath, 'utf8');
  source = replacePinnedMavenVersions(source);
  // This app feeds token IDs and masks directly to ONNX Runtime. It does not use
  // ORT Extensions custom ops; that artifact has its own version line and is
  // not versioned in lockstep with the runtime.
  const extensionsSetting = /boolean\s+ortExtensionsEnabled\s*=\s*readPackageJsonField\('onnxruntimeExtensionsEnabled'\)\s*==\s*"true"/;
  if (extensionsSetting.test(source)) source = source.replace(extensionsSetting, 'boolean ortExtensionsEnabled = false');
  else if (!/boolean\s+ortExtensionsEnabled\s*=\s*false/.test(source)) {
    throw new Error('onnxruntime-react-native: could not keep optional ORT Extensions disabled.');
  }
  const extensionsDependency = /if\s*\(\s*ortExtensionsEnabled\s*\)\s*\{\s*implementation\s+["']com\.microsoft\.onnxruntime:onnxruntime-extensions-android:[^"']+@aar["']\s*\}/;
  if (extensionsDependency.test(source)) source = source.replace(extensionsDependency, '');
  else if (source.includes('onnxruntime-extensions-android')) {
    throw new Error('onnxruntime-react-native: unexpected ORT Extensions dependency block; review before building.');
  }
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
  let packageJson;
  try {
    packageJson = require.resolve('onnxruntime-react-native/package.json', { paths: [projectRoot] });
  } catch {
    throw new Error('Install the pinned onnxruntime-react-native package before running Expo prebuild.');
  }
  return path.dirname(packageJson);
}

function patchPodfile(platformProjectRoot, resolvedPackageRoot) {
  const podfilePath = path.join(platformProjectRoot, 'Podfile');
  const source = fs.readFileSync(podfilePath, 'utf8');
  const relativePackagePath = path.relative(platformProjectRoot, resolvedPackageRoot).split(path.sep).join('/');
  const contents = generateCode.mergeContents({
    src: source,
    newSrc: `  pod 'onnxruntime-react-native', :path => ${JSON.stringify(relativePackagePath)}`,
    tag: 'onnxruntime-react-native',
    anchor: /^target.+do$/,
    offset: 1,
    comment: '  # onnxruntime-react-native',
  }).contents;
  fs.writeFileSync(podfilePath, contents);
}

function withOnnxRuntimeCompatibility(config) {
  // The upstream plugin hardcodes ../node_modules in the Podfile. Resolve the
  // package from the app root and generate a path relative to ios/ instead.
  config = withAppBuildGradle(config, (modConfig) => {
    if (modConfig.modResults.language !== 'groovy') {
      throw new Error('onnxruntime-react-native requires a Groovy app/build.gradle.');
    }
    modConfig.modResults.contents = generateCode.mergeContents({
      src: modConfig.modResults.contents,
      newSrc: "    implementation project(':onnxruntime-react-native')",
      tag: 'onnxruntime-react-native',
      anchor: /^dependencies[ \t]*\{$/,
      offset: 1,
      comment: '    // onnxruntime-react-native',
    }).contents;
    return modConfig;
  });
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
      const root = packageRoot(modConfig.modRequest.projectRoot);
      patchIos(root);
      patchPodfile(modConfig.modRequest.platformProjectRoot, root);
      return modConfig;
    },
  ]);
  return config;
}

const plugin = createRunOncePlugin(withOnnxRuntimeCompatibility, 'with-sauti-onnx-runtime-compatibility', '1.0.1');
module.exports = Object.assign(plugin, { packageRoot, patchAndroid, patchIos, patchPodfile, replacePinnedMavenVersions });

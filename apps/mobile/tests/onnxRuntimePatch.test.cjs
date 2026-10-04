const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { packageRoot, patchAndroid, patchIos, patchPodfile } = require('../plugins/withOnnxRuntimeCompatibility.js');

test('ONNX compatibility patch pins runtime artifacts, disables extensions, and removes legacy metadata', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sauti-ort-patch-'));
  t.after(() => {
    const tempRoot = path.resolve(os.tmpdir());
    const target = path.resolve(root);
    if (!target.startsWith(`${tempRoot}${path.sep}`) || !path.basename(target).startsWith('sauti-ort-patch-')) {
      throw new Error(`Refusing to remove a test directory outside the owned temporary prefix: ${target}`);
    }
    fs.rmSync(target, { recursive: true, force: true });
  });
  const android = path.join(root, 'android');
  fs.mkdirSync(android);
  fs.writeFileSync(path.join(android, 'build.gradle'), [
    'extractLibs "com.microsoft.onnxruntime:onnxruntime-android:latest.integration@aar"',
    'extractLibs "com.microsoft.onnxruntime:onnxruntime-android-qnn:latest.integration@aar"',
    'boolean ortExtensionsEnabled = readPackageJsonField(\'onnxruntimeExtensionsEnabled\') == "true"',
    'if (ortExtensionsEnabled) {',
    '  implementation "com.microsoft.onnxruntime:onnxruntime-extensions-android:1.24.3@aar"',
    '}',
    'if (VersionNumber.parse(REACT_NATIVE_VERSION) < VersionNumber.parse("0.71")) {',
    '  extractLibs "com.facebook.fbjni:fbjni:+"',
    '}',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'unimodule.json'), '{}');

  patchAndroid(root);
  const gradle = fs.readFileSync(path.join(android, 'build.gradle'), 'utf8');
  assert.match(gradle, /onnxruntime-android:1\.24\.3@aar/);
  assert.match(gradle, /onnxruntime-android-qnn:1\.24\.3@aar/);
  assert.match(gradle, /boolean ortExtensionsEnabled = false/);
  assert.doesNotMatch(gradle, /onnxruntime-extensions-android/);
  assert.match(gradle, /if \(REACT_NATIVE_MINOR_VERSION < 71\)/);
  assert.doesNotMatch(gradle, /VersionNumber\.parse|latest\.integration/);
  assert.equal(fs.existsSync(path.join(root, 'unimodule.json')), false);

  const podspec = path.join(root, 'onnxruntime-react-native.podspec');
  fs.writeFileSync(podspec, 'spec.dependency "onnxruntime-c"\n');
  patchIos(root);
  assert.match(fs.readFileSync(podspec, 'utf8'), /spec\.dependency "onnxruntime-c", "1\.24\.3"/);
});

test('package resolver finds an npm-workspace-hoisted ORT package', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sauti-ort-hoist-'));
  t.after(() => {
    const tempRoot = path.resolve(os.tmpdir());
    const target = path.resolve(root);
    if (!target.startsWith(`${tempRoot}${path.sep}`) || !path.basename(target).startsWith('sauti-ort-hoist-')) {
      throw new Error(`Refusing to remove a test directory outside the owned temporary prefix: ${target}`);
    }
    fs.rmSync(target, { recursive: true, force: true });
  });
  const projectRoot = path.join(root, 'apps', 'mobile');
  const hoistedRoot = path.join(root, 'node_modules', 'onnxruntime-react-native');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(hoistedRoot, { recursive: true });
  fs.writeFileSync(path.join(hoistedRoot, 'package.json'), JSON.stringify({ name: 'onnxruntime-react-native', version: '1.24.3' }));
  assert.equal(packageRoot(projectRoot), hoistedRoot);
});

test('iOS Podfile uses the resolved package path from ios/ even when ORT is hoisted', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sauti-ort-podfile-'));
  t.after(() => {
    const tempRoot = path.resolve(os.tmpdir());
    const target = path.resolve(root);
    if (!target.startsWith(`${tempRoot}${path.sep}`) || !path.basename(target).startsWith('sauti-ort-podfile-')) {
      throw new Error(`Refusing to remove a test directory outside the owned temporary prefix: ${target}`);
    }
    fs.rmSync(target, { recursive: true, force: true });
  });
  const iosRoot = path.join(root, 'apps', 'mobile', 'ios');
  const hoistedRoot = path.join(root, 'node_modules', 'onnxruntime-react-native');
  fs.mkdirSync(iosRoot, { recursive: true });
  fs.mkdirSync(hoistedRoot, { recursive: true });
  fs.writeFileSync(path.join(iosRoot, 'Podfile'), "platform :ios, '15.1'\ntarget 'SautiHost' do\nend\n");
  patchPodfile(iosRoot, hoistedRoot);
  patchPodfile(iosRoot, hoistedRoot);
  const podfile = fs.readFileSync(path.join(iosRoot, 'Podfile'), 'utf8');
  assert.match(podfile, /pod 'onnxruntime-react-native', :path => "\.\.\/\.\.\/\.\.\/node_modules\/onnxruntime-react-native"/);
  assert.equal((podfile.match(/pod 'onnxruntime-react-native'/g) ?? []).length, 1);
});

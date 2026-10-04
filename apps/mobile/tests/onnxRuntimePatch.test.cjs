const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { patchAndroid, patchIos } = require('../plugins/withOnnxRuntimeCompatibility.js');

test('ONNX compatibility patch pins native artifacts and removes unsupported autolink metadata', (t) => {
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
    'implementation "com.microsoft.onnxruntime:onnxruntime-extensions-android:latest.integration@aar"',
    'if (VersionNumber.parse(REACT_NATIVE_VERSION) < VersionNumber.parse("0.71")) {',
    '  extractLibs "com.facebook.fbjni:fbjni:+"',
    '}',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'unimodule.json'), '{}');

  patchAndroid(root);
  const gradle = fs.readFileSync(path.join(android, 'build.gradle'), 'utf8');
  assert.match(gradle, /onnxruntime-android:1\.24\.3@aar/);
  assert.match(gradle, /onnxruntime-extensions-android:1\.24\.3@aar/);
  assert.match(gradle, /if \(REACT_NATIVE_MINOR_VERSION < 71\)/);
  assert.doesNotMatch(gradle, /VersionNumber\.parse|latest\.integration/);
  assert.equal(fs.existsSync(path.join(root, 'unimodule.json')), false);

  const podspec = path.join(root, 'onnxruntime-react-native.podspec');
  fs.writeFileSync(podspec, 'spec.dependency "onnxruntime-c"\n');
  patchIos(root);
  assert.match(fs.readFileSync(podspec, 'utf8'), /spec\.dependency "onnxruntime-c", "1\.24\.3"/);
});

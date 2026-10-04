export type TranslationArtifact = {
  fileName: string;
  bytes: number;
  sha256: string;
};

export const TRANSLATION_MODEL = {
  id: 'opus-mt-en-sw-onnx-int8',
  runtimeVersion: 'onnxruntime-react-native@1.24.3',
  sourceLanguage: 'en',
  targetLanguage: 'sw',
  maxSourceTokens: 512,
  maxOutputTokens: 256,
  decoderStartTokenId: 58_949,
  endTokenId: 0,
  unknownTokenId: 1,
  padTokenId: 58_949,
  artifacts: [
    { fileName: 'encoder_model.onnx', bytes: 49_623_287, sha256: 'e3a96a46dc6539b446124f70132bfb317bcceaedcd0019436f36a16e8aefc0d7' },
    { fileName: 'decoder_model_merged.onnx', bytes: 86_784_789, sha256: '2f285f467a0fb3bd351827d59cf56cbcba6dd58919d86dbe3fab4ff7d6823907' },
    { fileName: 'source.spm', bytes: 820_602, sha256: '49d825aac86bf2083c0952b920479aa0d86376613cb9da552135723f9e6aebda' },
    { fileName: 'vocab.json', bytes: 1_505_062, sha256: '6b03d6100c9136fb67683d3306ef264a3d8ff90a41a9b4a5b1b3b8e3f4e7a2fd' },
    { fileName: 'generation_config.json', bytes: 304, sha256: '89defc130c8af9487e56fda621fc42af2130fb4576d625ec6534680d2014f469' },
  ] satisfies readonly TranslationArtifact[],
} as const;

export const TRANSLATION_MODEL_BYTES = TRANSLATION_MODEL.artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0);
export const TRANSLATION_BUNDLE_SHA256 = TRANSLATION_MODEL.artifacts
  .map(({ fileName, sha256 }) => `${fileName}\0${sha256}`)
  .join('\n');

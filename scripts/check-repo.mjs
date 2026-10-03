import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// High-confidence credential patterns, not a complete secret detector or Omar Gate.
const rules = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['github-fine-grained-token', /\bgithub_pat_[A-Za-z0-9_]{40,}\b/],
  ['openai-key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/],
];

export function credentialKinds(text) {
  return rules.filter(([, pattern]) => pattern.test(text)).map(([kind]) => kind);
}

export function checkTrackedFiles(cwd = process.cwd()) {
  const paths = execFileSync('git', ['ls-files', '-z'], { cwd, encoding: 'utf8' }).split('\0').filter(Boolean);
  const findings = [];
  for (const path of paths) {
    const absolute = resolve(cwd, path);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      findings.push({ path, kind: 'tracked-symlink-needs-review' });
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.size > 10 * 1024 * 1024) {
      findings.push({ path, kind: 'large-file-needs-review' });
      continue;
    }
    const text = readFileSync(absolute).toString('utf8');
    for (const kind of credentialKinds(text)) findings.push({ path, kind });
  }
  return { files: paths.length, findings };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = checkTrackedFiles();
  for (const finding of report.findings) console.error(JSON.stringify(finding));
  console.log(`Checked ${report.files} tracked files; ${report.findings.length} findings. Matched values are never printed.`);
  process.exitCode = report.findings.length ? 1 : 0;
}

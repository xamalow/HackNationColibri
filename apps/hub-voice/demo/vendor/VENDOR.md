# Vendored: livekit-client 2.22.3 (browser bundle)

| Field | Value |
|---|---|
| package | `livekit-client` |
| version | `2.22.3` |
| source | npm tarball `https://registry.npmjs.org/livekit-client/-/livekit-client-2.22.3.tgz` |
| tarball integrity (npm) | `sha512-jw9zBKXY5Gtr5MZ7vEON3QhMNccuDvYHck1PFSyG1aaateQPqgKZFBMgZkFZaXHIf9RV4MDW5xpTK2b/+qbwOg==` |
| tarball sha256 | `0f920230001fcbfdccb0bcd2efffd64da8594808908953ed466d4c39c1529fa3` |
| file inside the tarball | `package/dist/livekit-client.umd.js` (copied byte for byte to `livekit-client.umd.js`) |
| file sha256 | `7fa17e37af5e996d8a25f15a637dcc0620215bc01b394e5d209f726afe7dc04d` |
| license | Apache-2.0 (`LICENSE-livekit-client.txt`, the tarball's `package/LICENSE`) |
| why vendored | the demo page must work on an offline hub PC: no CDN, no install step at demo time |

The file is marked `-text` in `apps/hub-voice/.gitattributes`, so git never rewrites its line endings: the working copy on any OS is the exact published bytes, and `tests/test_vendor_provenance.py` checks the sha256 above against the file on every run.

To refresh: `npm pack livekit-client@<version>`, extract `package/dist/livekit-client.umd.js` and `package/LICENSE`, update every row of this table from `npm view livekit-client@<version> dist.tarball dist.integrity` and `sha256sum`, run the tests.

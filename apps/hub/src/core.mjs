// The hub uses the merged @sauti/core build for every booking, capacity and approval decision.
// Build it once: npm ci --prefix packages/core && npm run build --prefix packages/core
// (imported by relative path so the hub needs no change to the root workspace lock, which Platform owns).
export * from "../../../packages/core/dist/index.js";
import { createHash } from "node:crypto";

/** The Sha256 port the core expects: raw bytes in, lowercase hex out. */
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// stdin: JSON array of {id, text, lang?}; stdout: tagFeedback output. Used by eval_tagger.py.
import { tagFeedback } from "./tag_feedback.mjs";
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (buf += c));
process.stdin.on("end", () => process.stdout.write(JSON.stringify(tagFeedback(JSON.parse(buf)))));

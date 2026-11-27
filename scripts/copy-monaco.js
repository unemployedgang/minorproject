const fs = require("node:fs");
const path = require("node:path");

const src = path.join(process.cwd(), "node_modules", "monaco-editor", "min", "vs");
const dest = path.join(process.cwd(), "public", "monaco", "vs");

if (fs.existsSync(src)) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, force: true });
  console.log("Copied Monaco Editor assets to public/monaco/vs");
}

// Serves dist/ for local testing: node serve.js, then import http://localhost:8123 in the mod loader.
const http = require("http");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "dist");
const types = { ".js": "text/javascript", ".json": "application/json", ".png": "image/png" };
const port = Number(process.env.PORT) || 8123;

http
  .createServer((req, res) => {
    const file = path.normalize(path.join(root, decodeURIComponent(new URL(req.url, "http://x").pathname)));
    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Private-Network": "true",
      "Cache-Control": "no-store",
    };
    if (req.method === "OPTIONS") return res.writeHead(204, headers).end();
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404, headers).end("not found");
    res.writeHead(200, { ...headers, "Content-Type": types[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, "127.0.0.1", () => console.log(`Car Collisions mod at http://localhost:${port}`));

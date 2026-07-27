const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = __dirname;
const publicDir = path.join(root, "public");
const port = Number(process.env.PORT || 5177);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function openNeteaseMusic() {
  const candidates = [
    ["/usr/bin/open", ["/Applications/NeteaseMusic.app"]],
    ["/usr/bin/open", ["-b", "com.netease.163music"]],
    ["/usr/bin/open", ["-a", "NeteaseMusic"]],
    ["/usr/bin/open", ["-a", "网易云音乐"]],
  ];

  return new Promise((resolve, reject) => {
    let index = 0;

    const tryNext = () => {
      if (index >= candidates.length) {
        reject(new Error("NeteaseMusic app was not found by any known macOS open target."));
        return;
      }

      const [command, args] = candidates[index++];
      const child = spawn(command, args, { stdio: "ignore" });
      child.on("error", tryNext);
      child.on("close", (code) => {
        if (code === 0) {
          resolve({ command, args });
        } else {
          tryNext();
        }
      });
    };

    tryNext();
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "POST" && url.pathname === "/api/open/netease") {
    try {
      const launched = await openNeteaseMusic();
      sendJson(res, 200, { ok: true, launched });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method !== "GET") {
    sendJson(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  const safePath = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(publicDir, safePath));

  if (!filePath.startsWith(publicDir)) {
    sendJson(res, 403, { ok: false, error: "Forbidden" });
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendJson(res, 404, { ok: false, error: "Not found" });
      return;
    }

    const contentType = mimeTypes[path.extname(filePath)] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    });
    res.end(data);
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Gesture launcher running at http://127.0.0.1:${port}`);
});

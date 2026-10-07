#!/usr/bin/env python3
"""SPIKE-002 證據收集器：接收 iOS 模擬器內 App 送出的 JSON 報告與音檔。

模擬器與 Mac 共用網路堆疊，所以 App 連 127.0.0.1:8765 就會打到這裡。
用法：python3 spike/collector.py [port]（預設 8765），輸出到 spike/results/
"""
import json, os, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "results")
os.makedirs(OUT, exist_ok=True)


class H(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(n)
        ts = time.strftime("%H%M%S")
        if self.path.startswith("/report"):
            p = os.path.join(OUT, f"spike-002-report-{ts}.json")
            with open(p, "wb") as f:
                f.write(body)
            try:
                d = json.loads(body)
                rec = d.get("recorder", {})
                print(f"[collector] 報告 {len(body)}B → {os.path.basename(p)} "
                      f"| bytes={rec.get('bytes')} mime={rec.get('mime')} peak={rec.get('peak')}", flush=True)
            except Exception as e:
                print("[collector] 報告解析失敗:", e, flush=True)
        elif self.path.startswith("/audio"):
            mime = self.path.split("mime=")[-1] if "mime=" in self.path else "application/octet-stream"
            ext = "webm" if "webm" in mime else ("m4a" if "mp4" in mime or "aac" in mime else "bin")
            p = os.path.join(OUT, f"spike-002-audio-{ts}.{ext}")
            with open(p, "wb") as f:
                f.write(body)
            print(f"[collector] 音檔 {len(body)}B ({mime}) → {os.path.basename(p)}", flush=True)
        else:
            p = os.path.join(OUT, f"spike-002-other-{ts}.bin")
            with open(p, "wb") as f:
                f.write(body)
            print(f"[collector] 未知路徑 {self.path} {len(body)}B", flush=True)
        self.send_response(200)
        self._cors()
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok":true}')

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print(f"[collector] 監聽 http://127.0.0.1:{port} → {OUT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()

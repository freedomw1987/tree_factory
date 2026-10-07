/**
 * SPIKE-001 中繼 Worker：把本機 WebSocket 的音訊轉送到 Workers AI 的
 * `@cf/deepgram/nova-3` WebSocket，並把上游訊息原文回傳（不解析、不加工）。
 *
 * 目的：驗證 `diarize: true` 這個參數在 Workers AI 上到底有沒有效，
 * 以及回傳訊息裡有沒有逐字的 `speaker` 標籤。
 *
 * 只在本機 `wrangler dev` 跑，不部署。
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/ws") {
      return new Response("SPIKE-001 relay ready. Connect to /ws?diarize=0|1\n");
    }
    const diarize = url.searchParams.get("diarize") === "1";

    const input = {
      encoding: "linear16",
      sample_rate: "16000",
      language: "en",
      interim_results: "true",
      vad_events: "true",
      endpointing: "300",
      utterance_end_ms: "1000",
      smart_format: "true",
      punctuate: "true",
    };
    if (diarize) input.diarize = "true";

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    let upstream = null;
    try {
      const resp = await env.AI.run("@cf/deepgram/nova-3", input, { websocket: true });
      upstream = resp && resp.webSocket;
      if (!upstream) throw new Error("Workers AI 沒有回傳 webSocket");
      upstream.accept();
    } catch (err) {
      try {
        server.send(JSON.stringify({ __spike_error: String((err && err.message) || err), input }));
        server.close(1011, "upstream failed");
      } catch {}
      return new Response(null, { status: 101, webSocket: client });
    }

    try {
      server.send(JSON.stringify({ __spike_input: input }));
    } catch {}

    upstream.addEventListener("message", (ev) => {
      try {
        server.send(typeof ev.data === "string" ? ev.data : "[binary from upstream]");
      } catch {}
    });
    upstream.addEventListener("close", (ev) => {
      try {
        server.send(JSON.stringify({ __upstream_close: { code: ev.code, reason: ev.reason } }));
      } catch {}
      try { server.close(); } catch {}
    });
    upstream.addEventListener("error", () => {
      try { server.send(JSON.stringify({ __upstream_error: true })); } catch {}
    });

    server.addEventListener("message", (ev) => {
      try {
        if (typeof ev.data === "string") {
          if (ev.data === "close") upstream.close();
          else upstream.send(ev.data); // 例如 {"type":"CloseStream"}
        } else {
          upstream.send(ev.data);
        }
      } catch (err) {
        try { server.send(JSON.stringify({ __send_error: String((err && err.message) || err) })); } catch {}
      }
    });
    server.addEventListener("close", () => {
      try { upstream.close(); } catch {}
    });

    return new Response(null, { status: 101, webSocket: client });
  },
};

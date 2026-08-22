chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== "SN_FETCH") return false;

  (async () => {
    try {
      const headers = { "Accept": "application/json" };
      let token = msg.token || null;
      let source = token ? "cookie-from-background" : null;
      if (!token && typeof g_ck === "string" && g_ck) {
        token = g_ck;
        source = "page-global";
      }
      if (token) headers["X-UserToken"] = token;

      const res = await fetch(msg.url, {
        method: "GET",
        credentials: "include",
        headers
      });
      const text = await res.text();
      const responseHeaders = {};
      res.headers.forEach((v, k) => { responseHeaders[k] = v; });
      sendResponse({
        ok: true,
        status: res.status,
        text,
        headers: responseHeaders,
        tokenFound: Boolean(token),
        tokenSource: source
      });
    } catch (err) {
      sendResponse({ ok: false, error: String(err) });
    }
  })();

  return true;
});

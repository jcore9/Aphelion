import { Unauthorized, type ChatHost } from "./session";

const refusedStatus = /status code: 401\b/;

export const connectWebSocket: ChatHost["connect"] = (url, token, events) =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers: { authorization: `Bearer ${token}` },
    });
    let opened = false;
    socket.addEventListener("open", () => {
      opened = true;
      resolve({
        send: (text) => {
          socket.send(text);
        },
        close: () => {
          socket.close();
        },
      });
    });
    socket.addEventListener("message", ({ data }) => {
      if (typeof data === "string") events.message(data);
    });
    socket.addEventListener("error", (event) => {
      if (opened) return;
      const reason =
        "message" in event && typeof event.message === "string"
          ? event.message
          : "";
      reject(
        refusedStatus.test(reason)
          ? new Unauthorized()
          : new Error("couldn't connect"),
      );
    });
    socket.addEventListener("close", ({ code }) => {
      if (opened) events.close(code);
    });
  });

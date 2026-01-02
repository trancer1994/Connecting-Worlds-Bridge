const WebSocket = require("ws");

const wss = new WebSocket.Server({ port: 8080 });

const clients = new Set();

wss.on("connection", (socket) => {
  console.log("Client connected");
  clients.add(socket);

  socket.send(JSON.stringify({
    type: "status",
    message: "connected",
  }));

  socket.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      console.error("Invalid JSON:", raw.toString());
      return;
    }

    console.log("Received:", data);

    // Handle AAC text or generic chat
    if (data.type === "aac_text" || data.type === "chat") {
      // Broadcast to all connected web clients
      for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            type: "chat",
            from: data.from || "web",
            text: data.text,
          }));
        }
      }

      // Later: forward to Python TeamTalk bot
    }

    // Later: handle WebRTC signaling here
  });

  socket.on("close", () => {
    console.log("Client disconnected");
    clients.delete(socket);
  });

  socket.on("error", (err) => {
    console.error("Socket error:", err);
    clients.delete(socket);
  });
});

console.log("Connecting Worlds bridge server listening on ws://localhost:8080");

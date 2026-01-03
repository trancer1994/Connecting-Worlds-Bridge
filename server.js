const WebSocket = require("ws");

// Use Render's assigned port, or 8080 locally
const port = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port });

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

if (data.type === "handshake") {
  console.log("Handshake received from client:", data);

  // Store identity + capabilities on the socket
  socket.clientInfo = {
    id: data.client || "unknown-client",
    protocol: data.protocol || 1,
    capabilities: data.capabilities || [],
    connectedAt: Date.now()
  };

  socket.send(JSON.stringify({
    type: "handshake-ack",
    status: "ok",
    protocol: 1,
    message: "Handshake received. Ready for TeamTalk connection.",
    serverTime: Date.now()
  }));

  return;
}
// Handle ping/pong
if (data.type === "ping") {
  socket.send(JSON.stringify({
    type: "pong",
    sentAt: data.timestamp || Date.now(),
    serverTime: Date.now()
  }));
  return;
}
// Handle TeamTalk handshake request
if (data.type === "tt-handshake") {
  console.log("TeamTalk handshake request:", data);

  // TODO: Here you would initiate a TeamTalk connection using data.ttHost, data.ttPort, etc.

  // For now, just acknowledge the request
  socket.send(JSON.stringify({
    type: "tt-status",
    phase: "received",
    message: "TeamTalk handshake request received. (Not yet implemented.)"
  }));

  return;
}
    if (data.type === "aac_text" || data.type === "chat") {
      for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            type: "chat",
            from: data.from || "web",
            text: data.text,
          }));
        }
      }
    }
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

console.log(`Connecting Worlds bridge server listening on port ${port}`);


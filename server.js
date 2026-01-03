const WebSocket = require("ws");
const net = require("net");

// Use Render's assigned port, or 8080 locally
const port = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port });

const clients = new Set();

wss.on("connection", (socket) => {
  console.log("Client connected");
  clients.add(socket);

  // Initial status message
  socket.send(JSON.stringify({
    type: "status",
    message: "connected",
  }));

  let ttSocket = null; // TeamTalk TCP socket

  socket.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      console.error("Invalid JSON:", raw.toString());
      return;
    }

    console.log("Received:", data);

    // -------------------------------
    // 1. HANDSHAKE HANDLER
    // -------------------------------
    if (data.type === "handshake") {
      console.log("Handshake received from client:", data);

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

    // -------------------------------
    // 2. PING / PONG
    // -------------------------------
    if (data.type === "ping") {
      socket.send(JSON.stringify({
        type: "pong",
        sentAt: data.timestamp || Date.now(),
        serverTime: Date.now()
      }));
      return;
    }

    // -------------------------------
    // 3. TEAMTALK HANDSHAKE REQUEST
    // -------------------------------
    if (data.type === "tt-handshake") {
      console.log("TeamTalk handshake request:", data);

      const { ttHost, ttPort, username, password, channel } = data;

      // Notify client
      socket.send(JSON.stringify({
        type: "tt-status",
        phase: "received",
        message: "TeamTalk handshake request received. Connecting..."
      }));

      // Create TCP connection to TeamTalk server
      ttSocket = net.createConnection({ host: ttHost, port: ttPort }, () => {
        console.log("Connected to TeamTalk server");

        socket.send(JSON.stringify({
          type: "tt-status",
          phase: "connected",
          message: "Connected to TeamTalk server."
        }));

        // CORRECT TeamTalk login text command
        const loginCmd =
          `login username="${username}" ` +
          `password="${password}" ` +
          `protocol="5.14" ` +
          `clientname="ConnectingWorlds"\r\n`;

        ttSocket.write(loginCmd);

        socket.send(JSON.stringify({
          type: "tt-status",
          phase: "login-sent",
          message: "Sent TeamTalk login packet."
        }));

        // Optional: auto-join a channel
        if (channel && channel.trim() !== "") {
          const joinCmd = `join channel="${channel}"\r\n`;
          ttSocket.write(joinCmd);
        }
      });

      // Handle TeamTalk server messages
      ttSocket.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        console.log("TeamTalk server says:", text);

        socket.send(JSON.stringify({
          type: "tt-status",
          phase: "server-message",
          raw: text
        }));

        if (text.includes("error")) {
          socket.send(JSON.stringify({
            type: "tt-status",
            phase: "error",
            message: "TeamTalk server returned an error."
          }));
        }
      });

      ttSocket.on("close", () => {
        console.log("TeamTalk connection closed");

        socket.send(JSON.stringify({
          type: "tt-status",
          phase: "disconnected",
          message: "Disconnected from TeamTalk server."
        }));
      });

      ttSocket.on("error", (err) => {
        console.error("TeamTalk socket error:", err);

        socket.send(JSON.stringify({
          type: "tt-status",
          phase: "error",
          message: err.message
        }));
      });

      return;
    }

    // -------------------------------
    // 4. CHAT / AAC TEXT BROADCAST
    // -------------------------------
    if (data.type === "aac_text" || data.type === "chat") {
      for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            type: "chat",
            from: data.from || (socket.clientInfo?.id || "web"),
            text: data.text,
          }));
        }
      }
      return;
    }
  });

  // -------------------------------
  // SOCKET CLOSE / ERROR HANDLING
  // -------------------------------
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

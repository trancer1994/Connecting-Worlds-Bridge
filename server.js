const WebSocket = require("ws");
const net = require("net");

// Render provides PORT automatically; fallback for local dev
const port = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port });

console.log(`Connecting Worlds bridge server listening on port ${port}`);


// ==========================================================
// CLIENT CONNECTION HANDLER
// ==========================================================

wss.on("connection", (socket) => {
  console.log("Web client connected");

  // Track all connected web clients
  const clientInfo = {
    ws: socket,
    ttSocket: null,
    ttState: {
      channels: {},        // chanid → channel object
      users: {},           // userid → user object
      currentChannelId: 1, // auto-join root
      currentChannelPath: "/",
      keepalive: null
    }
  };

  // Initial status message
  sendToClient(socket, {
    type: "status",
    message: "connected"
  });


  // ========================================================
  // HANDLE MESSAGES FROM WEB CLIENT
  // ========================================================

  socket.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      console.error("Invalid JSON from client:", raw.toString());
      return;
    }

    console.log("Client → Bridge:", data);

    // -------------------------------
    // 1. BRIDGE HANDSHAKE
    // -------------------------------
    if (data.type === "handshake") {
      sendToClient(socket, {
        type: "handshake-ack",
        status: "ok",
        protocol: 1,
        message: "Handshake received. Ready for TeamTalk connection.",
        serverTime: Date.now()
      });
      return;
    }

    // -------------------------------
    // 2. PING / PONG
    // -------------------------------
    if (data.type === "ping") {
      sendToClient(socket, {
        type: "pong",
        sentAt: data.timestamp || Date.now(),
        serverTime: Date.now()
      });
      return;
    }

    // -------------------------------
    // 3. TEAMTALK HANDSHAKE
    // -------------------------------
    if (data.type === "tt-handshake") {
      startTeamTalkConnection(clientInfo, data);
      return;
    }

 // -------------------------------
// NEW: TEAMTALK CONNECT (frontend API)
// -------------------------------
if (data.type === "tt-connect") {
  startTeamTalkConnection(clientInfo, {
    ttHost: data.host,
    ttPort: data.port,
    username: data.username,
    password: data.password
  });
  return;
}
 
   // -------------------------------
    // 4. TEAMTALK CHAT
    // -------------------------------
    if (data.type === "tt-chat") {
      handleTeamTalkChat(clientInfo, data);
      return;
    }

    // -------------------------------
    // 5. TEAMTALK JOIN
    // -------------------------------
    if (data.type === "tt-join") {
      handleTeamTalkJoin(clientInfo, data);
      return;
    }

    // -------------------------------
    // 6. WEB CHAT BROADCAST
    // -------------------------------
    if (data.type === "chat" || data.type === "aac_text") {
      broadcastToAll({
        type: "chat",
        from: data.from || "web",
        text: data.text
      });
      return;
    }
  });


  // ========================================================
  // CLEANUP ON DISCONNECT
  // ========================================================

  socket.on("close", () => {
    console.log("Web client disconnected");

    if (clientInfo.ttSocket) {
      clientInfo.ttSocket.destroy();
      clientInfo.ttSocket = null;
    }

    if (clientInfo.ttState.keepalive) {
      clearInterval(clientInfo.ttState.keepalive);
      clientInfo.ttState.keepalive = null;
    }
  });

  socket.on("error", (err) => {
    console.error("WebSocket error:", err);
  });
});


// ==========================================================
// HELPER: SEND TO ONE CLIENT
// ==========================================================

function sendToClient(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}


// ==========================================================
// HELPER: BROADCAST TO ALL WEB CLIENTS
// ==========================================================

function broadcastToAll(obj) {
  const json = JSON.stringify(obj);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(json);
    }
  });
}


// ==========================================================
// TEAMTALK CONNECTION LOGIC
// ==========================================================

function startTeamTalkConnection(clientInfo, data) {
  const { ws } = clientInfo;
  const { ttHost, ttPort, username, password } = data;

  sendToClient(ws, {
    type: "tt-status",
    phase: "received",
    message: "TeamTalk handshake request received. Connecting..."
  });

  const ttSocket = net.createConnection({ host: ttHost, port: ttPort }, () => {
    console.log("Connected to TeamTalk server");

    sendToClient(ws, {
      type: "tt-status",
      phase: "connected",
      message: "Connected to TeamTalk server."
    });

    // Correct TeamTalk login command
    const loginCmd =
      `login username="${username}" ` +
      `password="${password}" ` +
      `nickname="${username}" ` +
      `protocol="5.14" ` +
      `clientname="ConnectingWorlds"\r\n`;

    ttSocket.write(loginCmd);

    sendToClient(ws, {
      type: "tt-status",
      phase: "login-sent",
      message: "Sent TeamTalk login packet."
    });

    // Auto-join root channel
    ttSocket.write(`join chanid=1\r\n`);

    // Start keepalive
    clientInfo.ttState.keepalive = setInterval(() => {
      if (!ttSocket.destroyed) {
        ttSocket.write("ping\r\n");
      }
    }, 30000);
  });

  clientInfo.ttSocket = ttSocket;

  // Handle TeamTalk incoming data
  ttSocket.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    console.log("TT → Bridge:", text);

    sendToClient(ws, {
      type: "tt-status",
      phase: "server-message",
      raw: text
    });

    const lines = text.split("\r\n").filter(l => l.trim().length > 0);
    for (const line of lines) {
      parseTeamTalkLine(line, clientInfo);
    }

    // Push updated state to UI
    sendToClient(ws, {
      type: "tt-channel-list",
      channels: Object.values(clientInfo.ttState.channels)
    });

    sendToClient(ws, {
      type: "tt-user-list",
      users: Object.values(clientInfo.ttState.users)
    });
  });

  ttSocket.on("close", () => {
    console.log("TeamTalk connection closed");

    if (clientInfo.ttState.keepalive) {
      clearInterval(clientInfo.ttState.keepalive);
      clientInfo.ttState.keepalive = null;
    }

    sendToClient(ws, {
      type: "tt-status",
      phase: "disconnected",
      message: "Disconnected from TeamTalk server."
    });
  });

  ttSocket.on("error", (err) => {
    console.error("TeamTalk error:", err);

    if (clientInfo.ttState.keepalive) {
      clearInterval(clientInfo.ttState.keepalive);
      clientInfo.ttState.keepalive = null;
    }

    sendToClient(ws, {
      type: "tt-status",
      phase: "error",
      message: err.message
    });
  });
}


// ==========================================================
// TEAMTALK CHAT HANDLER
// ==========================================================

function handleTeamTalkChat(clientInfo, data) {
  const { ws, ttSocket, ttState } = clientInfo;

  if (!ttSocket) {
    sendToClient(ws, {
      type: "tt-status",
      phase: "error",
      message: "Not connected to TeamTalk."
    });
    return;
  }

  const text = (data.text || "").trim();
  if (!text) return;

  const safeText = text.replace(/"/g, '\\"');

  const cmd = `chanmsg channel="${ttState.currentChannelPath}" text="${safeText}"\r\n`;
  ttSocket.write(cmd);

  sendToClient(ws, {
    type: "tt-chat",
    from: "admin",
    channel: ttState.currentChannelPath,
    text
  });
}


// ==========================================================
// TEAMTALK JOIN HANDLER
// ==========================================================

function handleTeamTalkJoin(clientInfo, data) {
  const { ws, ttSocket, ttState } = clientInfo;

  if (!ttSocket) {
    sendToClient(ws, {
      type: "tt-status",
      phase: "error",
      message: "Not connected to TeamTalk."
    });
    return;
  }

  const path = data.channel || "/";
  ttState.currentChannelPath = path;

  // Find channel ID by path
  let chanid = 1;
  for (const ch of Object.values(ttState.channels)) {
    if (ch.path === path) {
      chanid = ch.id;
      break;
    }
  }

  ttState.currentChannelId = chanid;

  ttSocket.write(`join chanid=${chanid}\r\n`);

  sendToClient(ws, {
    type: "tt-status",
    phase: "join-sent",
    message: `Requested join of channel ${path}`
  });
}


// ==========================================================
// TEAMTALK LINE PARSER
// ==========================================================

function parseTeamTalkLine(line, clientInfo) {
  const { ws, ttState } = clientInfo;

  function q(name) {
    const m = line.match(new RegExp(`${name}="([^"]*)"`));
    return m ? m[1] : null;
  }

  function n(name) {
    const m = line.match(new RegExp(`${name}=([0-9]+)`));
    return m ? parseInt(m[1], 10) : null;
  }

  // -------------------------------
  // CHANNEL ADDED
  // -------------------------------
  if (line.startsWith("addchannel ")) {
    const chanid = n("chanid");
    if (chanid != null) {
      ttState.channels[chanid] = {
        id: chanid,
        name: q("name") || q("channel") || "/",
        path: q("channel") || "/",
        parentId: n("parentid")
      };
    }
    return;
  }

  // -------------------------------
  // USER ADDED
  // -------------------------------
  if (line.startsWith("adduser ")) {
    const userid = n("userid");
    if (userid != null) {
      ttState.users[userid] = {
        id: userid,
        nickname: q("nickname") || q("username") || "user",
        username: q("username") || "user",
        channelId: n("chanid") || 1
      };
    }
    return;
  }

  // -------------------------------
  // USER REMOVED
  // -------------------------------
  if (line.startsWith("removeuser ")) {
    const userid = n("userid");
    if (userid != null) {
      delete ttState.users[userid];
    }
    return;
  }

  // -------------------------------
  // USER MOVED CHANNELS
  // -------------------------------
  if (line.startsWith("userupdate ")) {
    const userid = n("userid");
    const chanid = n("chanid");
    if (userid != null && chanid != null && ttState.users[userid]) {
      ttState.users[userid].channelId = chanid;
    }
    return;
  }

  // -------------------------------
  // CHANNEL MESSAGE
  // -------------------------------
  if (line.startsWith("chanmsg ")) {
    sendToClient(ws, {
      type: "tt-chat",
      from: q("nickname") || q("username") || "someone",
      channel: q("channel") || "/",
      text: q("text") || ""
    });
    return;
  }

  // -------------------------------
  // JOINED CHANNEL
  // -------------------------------
  if (line.startsWith("joined ")) {
    const channel = q("channel") || "/";
    ttState.currentChannelPath = channel;

    sendToClient(ws, {
      type: "tt-current-channel",
      channel
    });
    return;
  }
}


const fs = require("fs");
const express = require("express");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const bodyParser = require("body-parser");
const cors = require("cors");

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static("public")); // To serve HTML

// WhatsApp Client Setup
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ["--no-sandbox"],
  },
});

// Display QR code in the terminal
client.on("qr", (qr) => {
  console.log("Scan the QR code below to connect:");
  qrcode.generate(qr, { small: true });
});

// When the client is ready
client.on("ready", () => {
  console.log("WhatsApp client is ready and connected!");
});

// Handle received messages and log to console
client.on("message", (message) => {
  const currentTime = new Date().toLocaleString("en-US", {
    timeZone: "Asia/Colombo",
  });
  console.log(`${currentTime} | Message from ${message.from}: ${message.body}`);
});

// API to save user data
app.post("/api/add-user", (req, res) => {
  const { number, name, note } = req.body;

  if (!number || !/^7\d{8}$/.test(number)) {
    return res.status(400).json({ error: "Invalid phone number format." });
  }

  const filePath = "users.json";
  let users = [];

  if (fs.existsSync(filePath)) {
    const data = fs.readFileSync(filePath, "utf-8");
    users = data ? JSON.parse(data) : [];
  }

  users.push({ number, name, note });

  fs.writeFileSync(filePath, JSON.stringify(users, null, 2));
  res.status(200).json({ message: "User added successfully!" });
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// Initialize WhatsApp client
client.initialize();

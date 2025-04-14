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
app.use(express.static("public"));

// WhatsApp Client Setup
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ["--no-sandbox"],
  },
});

client.on("qr", (qr) => {
  console.log("Scan the QR code below to connect:");
  qrcode.generate(qr, { small: true });
});

client.on("ready", () => {
  console.log("WhatsApp client is ready and connected!");
});

// Load and save user data utility
const filePath = "users.json";

const loadUsers = () => {
  if (!fs.existsSync(filePath)) return [];
  const data = fs.readFileSync(filePath, "utf-8");
  return data ? JSON.parse(data) : [];
};

const saveUsers = (users) => {
  fs.writeFileSync(filePath, JSON.stringify(users, null, 2));
};

// Generate random OTP
const generateOTP = () =>
  Math.floor(100000 + Math.random() * 900000).toString();

// Send OTP via WhatsApp
const sendOTP = async (number, otp) => {
  const chatId = `94${number}@c.us`; // Assuming Sri Lankan numbers (change if necessary)
  const message = `You have successfully been added to the system. To continue, type the OTP below and send it back to us.\n\n${otp}`;
  await client.sendMessage(chatId, message);
};

// API to register user and send OTP
app.post("/api/add-user", async (req, res) => {
  const {
    number,
    name,
    age,
    gender,
    charactors,
    requestedAgeRange,
    requestedGender,
    requestedCharactors,
  } = req.body;

  if (!number || !/^7\d{8}$/.test(number)) {
    return res.status(400).json({ error: "Invalid phone number format." });
  }

  if (
    !name ||
    !age ||
    !gender ||
    !requestedGender ||
    !Array.isArray(charactors) ||
    charactors.length === 0 ||
    charactors.length > 5 ||
    !requestedAgeRange ||
    typeof requestedAgeRange.start !== "number" ||
    typeof requestedAgeRange.end !== "number" ||
    !Array.isArray(requestedCharactors) ||
    requestedCharactors.length === 0 ||
    requestedCharactors.length > 5
  ) {
    return res.status(400).json({ error: "Incomplete or invalid user data." });
  }

  const users = loadUsers();

  if (users.find((user) => user.number === number)) {
    return res.status(400).json({ error: "User already exists." });
  }

  const otp = generateOTP();

  users.push({
    number,
    name,
    age,
    gender,
    charactors,
    requestedAgeRange,
    requestedGender,
    requestedCharactors,
    verified: false,
    otp,
  });

  saveUsers(users);

  try {
    await sendOTP(number, otp);
    res.status(200).json({ message: "User added successfully, OTP sent!" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to send OTP via WhatsApp." });
  }
});

// WhatsApp message handler for OTP verification
client.on("message", async (message) => {
  const users = loadUsers();
  const senderNumber = message.from.replace("@c.us", "").slice(-9); // Get last 9 digits (Sri Lanka number)

  const user = users.find((u) => u.number === senderNumber);

  if (user && !user.verified) {
    if (message.body.trim() === user.otp) {
      user.verified = true;
      delete user.otp;

      saveUsers(users);
      await message.reply(
        "✅ Your number has been successfully verified and updated in our system!"
      );
      console.log(`User ${senderNumber} verified successfully.`);
    } else {
      await message.reply(
        "❌ Incorrect OTP. Please check the OTP and try again."
      );
      console.log(`User ${senderNumber} entered incorrect OTP.`);
    }
  } else if (user && user.verified) {
    await message.reply("ℹ️ Your number is already verified.");
  } else {
    await message.reply(
      "⚠️ Your number is not registered. Please register first."
    );
  }

  const currentTime = new Date().toLocaleString("en-US", {
    timeZone: "Asia/Colombo",
  });

  console.log(`${currentTime} | Message from ${message.from}: ${message.body}`);
});

// Start server and WhatsApp client
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

client.initialize();

const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const { Readable } = require('stream');
const { Server } = require('socket.io');
const nodemailer = require('nodemailer');
const Message = require('./models/Message');
const Call = require('./Call'); // Your Call model

const app = express();
const server = http.createServer(app);
const upload = multer();

app.use(cors());
app.use(express.json());

// === Nodemailer Transporter ===
// Replace with your Gmail and App Password
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: "subbuchoda0@gmail.com", // your Gmail
    pass: "nbykauqwedncujtn",      // your Gmail App Password
  },
});

const sendEmail = async (subject, text, toEmail = "subramanyamchoda50@gmail.com") => {
  try {
    const mailOptions = {
      from: "subbuchoda0@gmail.com",
      to: toEmail,
      subject,
      text,
    };

    const info = await transporter.sendMail(mailOptions);
    console.log("✉️ Email sent:", info.response);
  } catch (error) {
    console.error("❌ Error sending email:", error.message);
  }
};

// === MongoDB + GridFS Setup ===
let gridfsBucket;

mongoose.connect("YOUR_MONGO_URI_HERE", { useNewUrlParser: true, useUnifiedTopology: true });

const connection = mongoose.connection;
connection.once('open', () => {
  console.log('✅ MongoDB connected');
  gridfsBucket = new mongoose.mongo.GridFSBucket(connection.db, { bucketName: 'uploads' });
});

// === Socket.io Setup ===
const io = new Server(server, { cors: { origin: '*' } });

let onlineUsers = 0;
let lastSeen = {};
let messageReactions = {};
let typingUsers = {};
const onlineUsersMap = new Map(); // userId -> socket.id

io.on('connection', (socket) => {
  onlineUsers++;
  io.emit('updateOnlineUsers', onlineUsers);
  console.log('🟢 A user connected. Total:', onlineUsers);
  sendEmail('🟢 Server Active', `A user connected. Online users: ${onlineUsers}`);

  // --- User registration ---
  socket.on('register', (userId, role) => {
    socket.userId = userId;
    onlineUsersMap.set(userId, socket.id);
    lastSeen[socket.id] = new Date().toLocaleTimeString();

    io.emit('lastSeen', lastSeen);
    socket.broadcast.emit('userStatus', `${role} connected`);
    io.to(socket.id).emit('registered', { userId });

    if (role === 'f' || role === 'm') {
      sendEmail('👤 New User Connected', `User with role "${role}" just connected.`);
    }
  });

  // --- Messaging ---
  socket.on('sendMessage', async (msg) => {
    const message = new Message({
      text: msg.text,
      sender: msg.sender,
      image: msg.image || null,
    });
    const saved = await message.save();
    io.emit('message', saved);
  });

  socket.on('messageRead', (messageId, userId) => {
    io.emit('readMessage', { messageId, userId });
    io.emit('seenMessage', { messageId, userId });
  });

  // --- Typing ---
  socket.on('typing', (userId) => {
    typingUsers[userId] = true;
    io.emit('typing', Object.keys(typingUsers).length > 0);
  });

  socket.on('stopTyping', (userId) => {
    delete typingUsers[userId];
    if (Object.keys(typingUsers).length === 0) io.emit('stopTyping');
  });

  // --- Message reactions ---
  socket.on('messageReaction', (messageId, emoji) => {
    if (!messageReactions[messageId]) messageReactions[messageId] = [];
    messageReactions[messageId].push(emoji);
    io.emit('messageReaction', { messageId, emoji });
  });

  // --- WebRTC / Call Handling ---
  socket.on('call-user', ({ to, from, offer }) => {
    const targetSocketId = onlineUsersMap.get(to);
    if (targetSocketId) io.to(targetSocketId).emit('incoming-call', { from, offer });
    else io.to(socket.id).emit('user-offline', { to });
  });

  socket.on('accept-call', ({ to, from, answer }) => {
    const targetSocketId = onlineUsersMap.get(to);
    if (targetSocketId) io.to(targetSocketId).emit('call-accepted', { from, answer });
  });

  socket.on('ice-candidate', ({ to, candidate }) => {
    const targetSocketId = onlineUsersMap.get(to);
    if (targetSocketId) io.to(targetSocketId).emit('ice-candidate', { candidate, from: socket.userId });
  });

  socket.on('end-call', ({ to, from }) => {
    const targetSocketId = onlineUsersMap.get(to);
    if (targetSocketId) io.to(targetSocketId).emit('call-ended', { from });
  });

  // --- Disconnect ---
  socket.on('disconnect', () => {
    onlineUsers--;
    io.emit('updateOnlineUsers', onlineUsers);
    socket.broadcast.emit('userStatus', `A user disconnected`);
    lastSeen[socket.id] = new Date().toLocaleTimeString();
    io.emit('lastSeen', lastSeen);

    if (socket.userId) onlineUsersMap.delete(socket.userId);
    console.log('🔴 Total users:', onlineUsers);
  });
});

// === Chat Routes ===
app.get('/messages', async (req, res) => {
  const messages = await Message.find().sort({ createdAt: 1 });
  res.json(messages);
});

app.delete('/messages/:id', async (req, res) => {
  const { id } = req.params;
  await Message.findByIdAndDelete(id);
  io.emit('deleteMessage', id);
  res.sendStatus(204);
});

// === File Upload Routes ===
app.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file || !gridfsBucket) return res.status(400).json({ message: "No file uploaded or GridFS not initialized" });

  const bufferStream = new Readable();
  bufferStream.push(req.file.buffer);
  bufferStream.push(null);

  const uploadStream = gridfsBucket.openUploadStream(req.file.originalname, { contentType: req.file.mimetype });
  bufferStream.pipe(uploadStream);

  uploadStream.on("finish", () => res.json({ message: "File uploaded", fileId: uploadStream.id }));
  uploadStream.on("error", (err) => res.status(500).json({ message: "Error uploading file" }));
});

app.get('/files', async (req, res) => {
  try {
    const files = await gridfsBucket.find().toArray();
    res.json(files);
  } catch (error) {
    res.status(500).json({ message: "Error fetching files" });
  }
});

app.get('/files/:filename', async (req, res) => {
  try {
    const files = await gridfsBucket.find({ filename: req.params.filename }).toArray();
    if (!files.length) return res.status(404).json({ message: "File not found" });

    const file = files[0];
    res.set({
      "Content-Type": file.contentType || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${file.filename}"`,
    });

    gridfsBucket.openDownloadStream(file._id).pipe(res);
  } catch (error) {
    res.status(500).json({ message: "Error fetching file" });
  }
});

app.delete('/files/:filename', async (req, res) => {
  try {
    const files = await gridfsBucket.find({ filename: req.params.filename }).toArray();
    if (!files.length) return res.status(404).json({ message: "File not found" });

    await gridfsBucket.delete(files[0]._id);
    res.json({ message: "File deleted" });
  } catch (error) {
    res.status(500).json({ message: "Error deleting file" });
  }
});

// === Default Route ===
app.get('/', (req, res) => {
  sendEmail('🌐 Website Accessed', 'The website was opened by a user.');
  res.send("Welcome to the chat & file upload server");
});

// === Start Server ===

 
const onlineUsers1 = new Map(); // userId -> socket.id

io.on("connection", (socket) => {
  console.log("socket connected", socket.id);

  socket.on("register", (userId) => {
    socket.userId = userId;
    onlineUsers1.set(userId, socket.id);
    console.log("registered", userId, "->", socket.id);
    io.to(socket.id).emit("registered", { userId });
  });

  // Caller -> Callee: initial offer
  socket.on("call-user", ({ to, from, offer }) => {
    const targetSocketId = onlineUsers1.get(to);
    if (targetSocketId) {
      io.to(targetSocketId).emit("incoming-call", { from, offer });
    } else {
      io.to(socket.id).emit("user-offline", { to });
    }
  });

  // Callee accepts -> send answer back to caller
  socket.on("accept-call", ({ to, from, answer }) => {
    const targetSocketId = onlineUsers1.get(to);
    if (targetSocketId) {
      io.to(targetSocketId).emit("call-accepted", { from, answer });
    }
  });

  // ICE candidates exchange (bidirectional)
  socket.on("ice-candidate", ({ to, candidate }) => {
    const targetSocketId = onlineUsers1.get(to);
    if (targetSocketId) {
      io.to(targetSocketId).emit("ice-candidate", { candidate, from: socket.userId });
    }
  });

  socket.on("end-call", ({ to, from }) => {
    const targetSocketId = onlineUsers1.get(to);
    if (targetSocketId) {
      io.to(targetSocketId).emit("call-ended", { from });
    }
  });

  socket.on("disconnect", () => {
    if (socket.userId) {
      onlineUsers1.delete(socket.userId);
      console.log("user disconnected", socket.userId);
    }
  });
});

// (Optional) endpoint to save call history (if you wire up a DB)
app.post("/api/calls", async (req, res) => {
  try {
    // Save to DB - left as TODO or implement as needed
    res.status(201).json({ ok: true, body: req.body });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save call" });
  }
});

// === Start Server ===
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
 








